import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { Sheet } from '@silk-hq/components';
import '@silk-hq/components/unlayered-styles.css';

const alerts = [
  ['driver-on-break', 'Driver on break', 'cup.and.saucer.fill'],
  ['reduced-service', 'Reduced service', 'bus.fill'],
  ['traffic', 'Traffic', 'exclamationmark.triangle.fill'],
  ['other', 'Other', 'questionmark.circle.fill'],
] as const;

function AlertSheet() {
  const [presented, setPresented] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function postAlert(alert: string) {
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alert }),
      });
      if (!response.ok) throw new Error('Alert request failed');
      setPresented(false);
    } catch {
      setError('Could not send the alert. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    // This app is exclusively non-commercial; commercial use requires a Silk license.
    <Sheet.Root
      license="non-commercial"
      sheetRole="dialog"
      presented={presented}
      onPresentedChange={setPresented}
    >
      <Sheet.Trigger className="report-button" aria-label="Report a service alert">
        <img className="icon--report" src="/assets/icons/exclamationmark.bubble.fill.svg" alt="" />
      </Sheet.Trigger>
      <Sheet.Portal>
        <Sheet.View className="alert-view" contentPlacement="bottom" tracks="bottom">
          <Sheet.Backdrop className="alert-backdrop" />
          <Sheet.Content className="alert-content">
            <Sheet.BleedingBackground className="alert-background" />
            <div className="alert-sheet">
              <div className="alert-handle" aria-hidden="true" />
              <header className="alert-header">
                <Sheet.Trigger className="alert-close" action="dismiss" aria-label="Close alert options">
                  <span className="icon icon--close" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m12 19-7-7 7-7" />
                      <path d="M19 12H5" />
                    </svg>
                  </span>
                </Sheet.Trigger>
                <div className="alert-heading">
                  <Sheet.Title className="alert-title">Choose an alert</Sheet.Title>
                </div>
                <span aria-hidden="true" />
              </header>
              <div className="alert-options" role="group" aria-label="Choose an alert">
                {alerts.map(([value, label, icon]) => (
                  <button
                    key={value}
                    className="alert-option"
                    type="button"
                    disabled={submitting}
                    onClick={() => void postAlert(value)}
                  >
                    <img className="alert-option-icon" src={`/assets/icons/${icon}.svg`} alt="" />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
              <p className="alert-description">Choose the alert that best describes the current service issue.</p>
              <p className="alert-status" role="status" aria-live="polite">{submitting ? 'Sending alert…' : error}</p>
            </div>
          </Sheet.Content>
        </Sheet.View>
      </Sheet.Portal>
    </Sheet.Root>
  );
}

const container = document.getElementById('alert-sheet-root');
if (container) createRoot(container).render(<AlertSheet />);
