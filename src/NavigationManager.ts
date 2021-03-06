import { SignalDispatcher } from 'strongly-typed-events';

import { ComponentAdapterInterface } from './adapters/ComponentAdapterInterface';
import { NavigationOptions } from './NavigationOptions';
import { createNavigator, NavigatorInterface, NavigatorProvider } from './navigators/NavigatorInterface';
import { deviceRuns, TiAppInternal } from './utility';

/**
 * Marker interface to identify Titanium views that can be opened and closed.
 */
export interface OpenableViewInterface extends Titanium.Proxy {
    open(...args: any[]): void;
    close(...args: any[]): void;
}

/**
 * Configuration object for the navigation manager.
 */
export interface NavigationManagerConfiguration {
    componentAdapter: ComponentAdapterInterface;
    navigatorProviders: ReadonlyArray<NavigatorProvider>;
}

/**
 * Manages navigation inside the app by using different navigators which
 * handle opening and closing views inside the view hierarchy.
 */
export class NavigationManager {
    /**
     * The default navigation options that will be applied to every navigation
     * between two views.
     */
    public defaultNavigationOptions = {};

    /**
     * Navigation options for the current route.
     */
    public currentNavigationOptions: NavigationOptions;

    /**
     * A set of views that can automatically be openend using one of the available
     * navigators.
     */
    public readonly openableViews: Set<string> = new Set();

    /**
     * Signal dispatcher for when a natively triggered navigation occured.
     */
    public nativeBackNavigationSignal = new SignalDispatcher();

    /**
     * Stack of navigators.
     */
    private navigators: NavigatorInterface[] = [];

    /**
     * Reference to the currently active navigator.
     */
    private activeNavigator: NavigatorInterface | null = null;

    /**
     * Adapter to interact with a component of the target framework.
     */
    private componentAdapter: ComponentAdapterInterface;

    /**
     * Set of providers for every registered navigator.
     */
    private navigatorProviders: Set<NavigatorProvider> = new Set();

    /**
     * Internal Flag indicating that a native back navigation is in progress.
     */
    private _nativeBackNavigation = false;

    /**
     * Internal flag indicating that a back navigation triggered by
     * {@link TitaniumPlatformLocation} is in progress.
     *
     * @TODO
     */
    private _locationBackNavigation = false;

    constructor(config: NavigationManagerConfiguration) {
        this.currentNavigationOptions = this.defaultNavigationOptions;
        this.componentAdapter = config.componentAdapter;
        config.navigatorProviders.forEach(provider => this.registerNavigatorProvider(provider));

        this.applyAndroidLiveViewPatch();
    }

    /**
     * Returns true if a native back navigation is currently in progress.
     */
    get isNativeBackNavigation(): boolean {
        return this._nativeBackNavigation;
    }

    /**
     * Sets the flag indicating a native back navigation.
     */
    set nativeBackNavigation(nativeBackNavigation: boolean) {
        this._nativeBackNavigation = nativeBackNavigation;
    }

    /**
     * Returns true if a back navigation triggered by a location change
     * is currently in progress.
     */
    get isLocationBackNavigation(): boolean {
        return this._locationBackNavigation;
    }

    /**
     * Sets the flag indicating a location triggered back navigation.
     */
    set locationBackNavigation(locationBackNavigation: boolean) {
        this._locationBackNavigation = locationBackNavigation;
    }

    public registerNavigatorProvider(provider: NavigatorProvider): void {
        this.navigatorProviders.add(provider);
        provider.class.supportedViews.forEach(viewApiName => this.openableViews.add(viewApiName));
    }

    /**
     * Creates the root navigator and opens its root window.
     *
     * @param component
     */
    public createAndOpenRootNavigator(component: any): void {
        const navigator = this.createNavigator(component);
        this.pushNavigator(navigator);
        navigator.openRootWindow();
    }

    /**
     * Opens
     *
     * @param component
     */
    public open(component: any): void {
        const componentName = this.componentAdapter.getComponentName(component);

        if (!this.activeNavigator) {
            throw new Error(`No active navigator available to handle navigation to ${componentName}`);
        }

        const titaniumView = this.findTopLevelOpenableView(component);
        if (!this.activeNavigator.canOpen(titaniumView)) {
            throw new Error(`Currently active navigator ${this.activeNavigator} cannot open a ${titaniumView.apiName}`);
        }

        Ti.API.debug(`NavigationManager - ${this.activeNavigator}.open(${titaniumView.apiName}) from component: ${componentName}`);
        this.activeNavigator.open(titaniumView, this.currentNavigationOptions);

        if (this.activeNavigator.shouldYieldNavigating(titaniumView)) {
            Ti.API.trace(`NavigationManager - ${this.activeNavigator} cannot continue after ${titaniumView.apiName} was opened, yielding to new navigator.`);
            const navigator = this.createNavigator(component);
            this.pushNavigator(navigator);

            if (this.currentNavigationOptions.clearHistory) {
                Ti.API.debug('NavigationManager - clearHistory set, closing all previous navigators.');
                const removedNavigators = this.navigators.splice(0, this.navigators.length - 1);
                removedNavigators.forEach(n => n.closeNavigator());
            }
        }

        // @todo Handle modals -> create new appropriate navigator
    }

    public back(): void {
        if (!this.activeNavigator) {
            throw new Error('No active navigator available to handle back navigation request.');
        }

        if (this.activeNavigator.canGoBack()) {
            Ti.API.trace(`NavigationManager - ${this.activeNavigator} has windows it can close, going back.`);
            this.activeNavigator.back();
        } else {
            if (this.navigators.length === 1) {
                throw new Error('Tried to close the root navigator, which is not allowed.');
            }
            Ti.API.trace(`NavigationManager - ${this.activeNavigator} has no more windows it can close, closing and popping navigator.`);
            this.activeNavigator.closeRootWindow();
            this.popNavigator();
        }
    }

    public resetBackNavigationFlags(): void {
        this.nativeBackNavigation = false;
        this.locationBackNavigation = false;
    }

    /**
     * Patches live view and navigation signal dispatching behavior on Android.
     *
     * On Android the topmost window's `close` event is fired after the App was
     * reloaded using LiveView AND the new window already fired its `open`
     * event. This screws up internal router state, so we set s flag to
     * avoid sending the native back navigation signal in this particular case.
     */
    public applyAndroidLiveViewPatch(): void {
        if (!deviceRuns('android')) {
            return;
        }

        const App: TiAppInternal = Ti.App as any;
        const _restart = App._restart;
        _restart.__liveViewRestart = false;
        if (!_restart.__navigatorPatch) {
            App._restart = (): void => {
                _restart.__liveViewRestart = true;
                _restart();
            }
            App._restart.__navigatorPatch = true
        }
    }

    /**
     * Creates a new navigator instance for the given component.
     *
     * Removes the component from the DOM tree and searches for the first
     * openable view element. Then it tries to find the appropriate
     * navigator for this view and creates it.
     *
     * @param component
     */
    private createNavigator(component: any): NavigatorInterface {
        const componentName = this.componentAdapter.getComponentName(component);
        this.componentAdapter.detachComponent(component);

        const titaniumView = this.findTopLevelOpenableView(component);
        let navigator: NavigatorInterface | undefined;
        for (const candidateNavigatorProvider of this.navigatorProviders) {
            if (candidateNavigatorProvider.class.canHandle(titaniumView)) {
                Ti.API.debug(`Creating navigator ${candidateNavigatorProvider.class.name} for component ${componentName}.`);
                navigator = createNavigator(candidateNavigatorProvider.class, titaniumView, ...candidateNavigatorProvider.deps);
                break;
            }
        }

        if (navigator === undefined) {
            throw new Error(`Could not resolve matching navigator for component ${componentName} (top-level view: ${titaniumView.apiName}).`);
        }

        return navigator;
    }

    /**
     * Activates the passed navigator, subscribing to native navigation state events.
     *
     * @param navigator Navigator to activate
     */
    private activateNavigator(navigator: NavigatorInterface): void {
        this.activeNavigator = navigator;
        this.removeNativeNavigationSignalListener = this.activeNavigator.nativeNavigationSignal.subscribe(() => {
            if (this.isNativeBackNavigation) {
                throw new Error('Native back navigation is already in progress');
            }

            this._nativeBackNavigation = true;
            this.nativeBackNavigationSignal.dispatch();
            if (this.activeNavigator && !this.activeNavigator.canGoBack() && this.navigators.length > 1) {
                this.popNavigator();
            }
        });
        navigator.activate();

        Ti.API.trace(`NavigationManager - new active navigator: ${this.activeNavigator}`);
    }

    private deactivateNavigator(navigator: NavigatorInterface): void {
        this.removeNativeNavigationSignalListener()
        navigator.deactivate()
    }

    /**
     * Pushes a new navigator on the stack and activates it.
     *
     * @param navigator Navigator to push on the stack
     */
    private pushNavigator(navigator: NavigatorInterface): void {
        Ti.API.trace('NavigationManager.pushNavigator');

        if (this.activeNavigator) {
            this.deactivateNavigator(this.activeNavigator);
        }

        this.navigators.push(navigator);
        this.activateNavigator(navigator);
    }

    private popNavigator(): NavigatorInterface {
        if (this.navigators.length === 1) {
            throw new Error(`The last navigator in the stack connot be closed.`);
        }

        const poppedNavigator = this.navigators.pop() as NavigatorInterface;
        this.deactivateNavigator(poppedNavigator);
        this.activateNavigator(this.navigators[this.navigators.length - 1]);

        return poppedNavigator;
    }

    private findTopLevelOpenableView(component: any): OpenableViewInterface {
        const componentName = this.componentAdapter.getComponentName(component);
        const candidateElement = this.componentAdapter.getTopmostTitaniumElement(component);
        if (candidateElement === null) {
            throw new Error(`Component ${componentName} has no child elements to open, cannot use it for window navigation.`);
        }
        if (!this.isOpenableView(candidateElement.titaniumView)) {
            throw new Error(`Could not find an openable Titanium view as the top-level element in component ${componentName}. Found ${candidateElement} but expected one of ${Array.from(this.openableViews).join(', ')}.`);
        }

        return candidateElement.titaniumView;
    }

    /**
     * @param view
     */
    private isOpenableView(view: Titanium.Proxy): view is OpenableViewInterface {
        if (!view) {
            return false;
        }

        return this.openableViews.has(view.apiName);
    }

    private removeNativeNavigationSignalListener: () => void = () => null;
}
