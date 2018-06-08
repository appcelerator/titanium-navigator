import { AbstractTransition } from '../AbstractTransition';
import { NavigationTransition } from '../NavigationTransition';

export class SlideLeftTransition extends AbstractTransition {
    public name: string = 'slideLeft';

    public initializeAnimations(futureView: Titanium.UI.View, currentView: Titanium.UI.View, transition: NavigationTransition) {
        futureView.transform = Titanium.UI.create2DMatrix().translate(Titanium.Platform.displayCaps.platformWidth, 0);
        const animation = Ti.UI.createAnimation({
            transform: Ti.UI.create2DMatrix().translate(0, 0),
            duration: transition.duration ? transition.duration : this.defaultDuration,
        });
        const startAnimation = () => {
            futureView.removeEventListener('open', startAnimation);
            futureView.animate(animation);
        };
        futureView.addEventListener('open', startAnimation);
    }
}
