import React, { useCallback, useEffect, useState } from 'react';
import { connect } from 'react-redux';

import { createToolbarEvent } from '../../../analytics/AnalyticsEvents';
import { sendAnalytics } from '../../../analytics/functions';
import { IReduxState } from '../../../app/types';
import { translate } from '../../../base/i18n/functions';
import { IconEnlarge } from '../../../base/icons/svg';
import { getLogger } from '../../../base/logging/functions';
import AbstractButton, { IProps as AbstractButtonProps } from '../../../base/toolbox/components/AbstractButton';
import { closeOverflowMenuIfOpen } from '../../actions.web';

const LARGE_VIDEO_ID = 'largeVideo';

const logger = getLogger('app:toolbox:pip');

/**
 * Returns true if the PiP API is available AND the document currently has
 * an HTMLVideoElement that has a usable media stream attached.
 *
 * @returns {boolean}
 */
function isPiPSupported(): boolean {
    if (typeof document === 'undefined') {
        return false;
    }

    // document.pictureInPictureEnabled may be undefined on older browsers.
    if (!document.pictureInPictureEnabled) {
        return false;
    }

    const video = document.getElementById(LARGE_VIDEO_ID) as HTMLVideoElement | null;

    if (!video) {
        return false;
    }

    // Safari iOS uses requestPictureInPicture but reports false for
    // document.pictureInPictureEnabled. We don't try to support that path
    // here; the API guard above is enough.

    // The video must have either a srcObject (preferred) or a usable src
    // AND some loaded metadata (so the browser will accept PiP).
    if (video.srcObject) {
        return true;
    }

    return typeof video.videoWidth === 'number' && video.videoWidth > 0;
}

/**
 * Returns the large video element if it exists.
 *
 * @returns {HTMLVideoElement | null}
 */
function getLargeVideo(): HTMLVideoElement | null {
    return document.getElementById(LARGE_VIDEO_ID) as HTMLVideoElement | null;
}

interface IProps extends AbstractButtonProps {
    _isInPictureInPicture?: boolean;
    _isPiPSupported?: boolean;
}

/**
 * Picture-in-Picture toolbar button. Toggles the W3C PiP API on the large
 * video element so the user can switch tabs / open other apps without losing
 * the active speaker.
 */
class PictureInPictureButton extends AbstractButton<IProps> {
    override accessibilityLabel = 'toolbar.accessibilityLabel.pip';
    override toggledAccessibilityLabel = 'toolbar.accessibilityLabel.pipExit';
    override label = 'toolbar.pip';
    override icon = IconEnlarge;

    override _getTooltip() {
        return this.props._isInPictureInPicture ? 'toolbar.pipExit' : 'toolbar.pip';
    }

    override _isToggled() {
        return Boolean(this.props._isInPictureInPicture);
    }

    override _isDisabled() {
        return !this.props._isPiPSupported;
    }

    override _handleClick() {
        const { dispatch } = this.props;

        dispatch(closeOverflowMenuIfOpen());
        togglePictureInPicture();
    }
}

/**
 * Actually perform the toggle against the document / large video element.
 * Exported as a stand-alone helper so it can be re-used by tests / hot keys.
 *
 * @returns {void}
 */
export function togglePictureInPicture(): void {
    const video = getLargeVideo();

    if (!video) {
        logger.warn('large video element not found, cannot toggle PiP');

        return;
    }

    // Exit current PiP (might be on a different element).
    if (document.pictureInPictureElement) {
        sendAnalytics(createToolbarEvent('pip.toggle', { enable: false }));

        document.exitPictureInPicture().catch(err => {
            logger.warn('failed to exit PiP', err);
        });

        return;
    }

    sendAnalytics(createToolbarEvent('pip.toggle', { enable: true }));

    video.requestPictureInPicture().catch(err => {
        // Common reasons: video has no source yet (race), user denied, browser
        // disallowed PiP for this media (e.g. MediaSource without MSE PiP).
        logger.warn('failed to enter PiP', err);
    });
}

/**
 * Wrapper that injects PiP support and document.pictureInPictureElement
 * state into the button, since that state is not in Redux. Uses observers
 * instead of polling for a cleaner / more reactive implementation.
 *
 * @param {IProps} props - Props passed in from the connect HOC.
 * @returns {React.ReactNode}
 */
function PictureInPictureButtonWithState(props: IProps) {
    const [ isInPictureInPicture, setIsInPictureInPicture ] = useState(Boolean(document.pictureInPictureElement));
    const [ pipSupported, setPipSupported ] = useState(() => isPiPSupported());

    const refreshSupport = useCallback(() => {
        setPipSupported(isPiPSupported());
    }, []);

    // Watch the DOM for changes that affect PiP support:
    // - the largeVideo element appearing / disappearing (join / leave)
    // - its srcObject being set / replaced (track changes)
    // - its src being changed
    // - its loadedmetadata firing
    useEffect(() => {
        const video = getLargeVideo();

        if (!video) {
            return;
        }

        const onEnter = () => setIsInPictureInPicture(true);
        const onLeave = () => setIsInPictureInPicture(false);
        const onLoadedMetadata = () => refreshSupport();
        const onPlay = () => refreshSupport();

        video.addEventListener('enterpictureinpicture', onEnter);
        video.addEventListener('leavepictureinpicture', onLeave);
        video.addEventListener('loadedmetadata', onLoadedMetadata);
        video.addEventListener('play', onPlay);

        // MutationObserver catches src changes (srcObject isn't an attribute
        // and can't be observed directly via MutationObserver, but the
        // loadedmetadata / play events plus the poller below cover that).
        const observer = new MutationObserver(refreshSupport);

        observer.observe(video, {
            attributes: true,
            attributeFilter: [ 'src' ]
        });

        // Lightweight poller for srcObject changes. We avoid monkey-patching
        // the property (browsers may freeze it) and just compare by reference.
        let lastSrcObject = video.srcObject;

        const srcObjectCheckInterval = setInterval(() => {
            if (video.srcObject !== lastSrcObject) {
                lastSrcObject = video.srcObject;
                refreshSupport();
            }
        }, 1000);

        // Watch the DOM in case the largeVideo element is added/removed later
        // (e.g. user is in prejoin, then joins).
        const parent = video.parentElement ?? document.body;
        const domObserver = new MutationObserver(() => {
            if (getLargeVideo() !== video) {
                refreshSupport();
            }
        });

        domObserver.observe(parent, { childList: true, subtree: false });

        refreshSupport();

        return () => {
            video.removeEventListener('enterpictureinpicture', onEnter);
            video.removeEventListener('leavepictureinpicture', onLeave);
            video.removeEventListener('loadedmetadata', onLoadedMetadata);
            video.removeEventListener('play', onPlay);
            observer.disconnect();
            domObserver.disconnect();
            clearInterval(srcObjectCheckInterval);
        };
    }, [ refreshSupport ]);

    return (
        <PictureInPictureButton
            { ...props }
            _isInPictureInPicture = { isInPictureInPicture }
            _isPiPSupported = { pipSupported } />
    );
}

const mapStateToProps = (_state: IReduxState) => ({
    visible: document.pictureInPictureEnabled
});

export default translate(connect(mapStateToProps)(PictureInPictureButtonWithState));
