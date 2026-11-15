'use client';

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', padding: 32, textAlign: 'center', color: '#15233b' }}>
        <h1>LiveRoom hit a snag</h1>
        <p>Reload to try again.</p>
        <button onClick={() => reset()} style={{ padding: '12px 20px', borderRadius: 10, border: '1.5px solid #15233b', background: '#8d402e', color: '#fff', fontWeight: 600 }}>
          Reload
        </button>
      </body>
    </html>
  );
}