import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { Sheet } from '@silk-hq/components';

const decisionKey = 'shuttle-location-consent';

function LocationConsent() {
  const [presented, setPresented] = useState(() => localStorage.getItem(decisionKey) === null);
  const [sharing, setSharing] = useState(() => localStorage.getItem(decisionKey) === 'allowed');

  useEffect(() => {
    const update = (event: Event) => setSharing((event as CustomEvent<boolean>).detail);
    window.addEventListener('shuttle-location-sharing-change', update);
    return () => window.removeEventListener('shuttle-location-sharing-change', update);
  }, []);

  function decide(allow: boolean) {
    localStorage.setItem(decisionKey, allow ? 'allowed' : 'declined');
    setPresented(false);
    if (allow) window.dispatchEvent(new Event('shuttle-location-consent'));
  }

  return <>
    {/* This app is exclusively non-commercial; commercial use requires a Silk license. */}
    <Sheet.Root
      license="non-commercial"
      sheetRole="dialog"
      presented={presented}
      onPresentedChange={(next) => {
        setPresented(next);
        if (!next && localStorage.getItem(decisionKey) === null) localStorage.setItem(decisionKey, 'declined');
      }}
    >
      <Sheet.Portal>
        <Sheet.View className="location-view" contentPlacement="bottom" tracks="bottom">
          <Sheet.Backdrop className="alert-backdrop" />
          <Sheet.Content className="location-content">
            <Sheet.BleedingBackground className="alert-background" />
            <div className="location-sheet">
              <div className="alert-handle" aria-hidden="true" />
              <Sheet.Title className="location-title">Share location for live ETAs?</Sheet.Title>
              <p className="location-description">
                Location helps detect shuttle rides and improve arrival estimates. It is shared only while this tab is open and cleared shortly after updates stop.
              </p>
              <div className="location-actions">
                <button className="location-allow" type="button" onClick={() => decide(true)}>Allow location</button>
                <button className="location-decline" type="button" onClick={() => decide(false)}>Not now</button>
              </div>
            </div>
          </Sheet.Content>
        </Sheet.View>
      </Sheet.Portal>
    </Sheet.Root>

    <Sheet.Root license="non-commercial" sheetRole="dialog">
      <Sheet.Trigger className="settings-button" aria-label="Settings">
        <img className="settings-icon" src="/assets/icons/gearshape.fill.svg" alt="" />
      </Sheet.Trigger>
      <Sheet.Portal>
        <Sheet.View className="location-view" contentPlacement="bottom" tracks="bottom">
          <Sheet.Backdrop className="alert-backdrop" />
          <Sheet.Content className="location-content">
            <Sheet.BleedingBackground className="alert-background" />
            <div className="location-sheet settings-sheet">
              <div className="alert-handle" aria-hidden="true" />
              <header className="settings-header">
                <Sheet.Title className="location-title">Settings</Sheet.Title>
                <Sheet.Trigger className="alert-close" action="dismiss" aria-label="Close settings">
                  <span className="icon icon--close" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m18 6-12 12M6 6l12 12" /></svg></span>
                </Sheet.Trigger>
              </header>
              <div className="settings-option">
                <div>
                  <h2 className="settings-option-title">Location sharing</h2>
                  <p className="location-description">Location helps detect shuttle rides and improve arrival estimates. It is shared only while this tab is open and cleared shortly after updates stop.</p>
                </div>
                <button
                  className="settings-switch"
                  type="button"
                  role="switch"
                  aria-checked={sharing}
                  aria-label="Share location for live ETAs"
                  onClick={() => {
                    const next = !sharing;
                    localStorage.setItem(decisionKey, next ? 'allowed' : 'declined');
                    window.dispatchEvent(new Event(next ? 'shuttle-location-consent' : 'shuttle-location-stop'));
                  }}
                ><span /></button>
              </div>
            </div>
          </Sheet.Content>
        </Sheet.View>
      </Sheet.Portal>
    </Sheet.Root>
  </>;
}

const container = document.getElementById('location-consent-root');
if (container) createRoot(container).render(<LocationConsent />);
