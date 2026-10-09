import type { ReactElement } from 'react';
import { useEvent, useNetifly, useNotifications } from '@netiflyjs/react';

type Events = {
  'comment.created': { commentId: string };
};

export function App(): ReactElement {
  const { status } = useNetifly<Events>();
  const { items, unreadCount, markRead, dismiss, respond } = useNotifications<Events>();

  useEvent<Events, 'comment.created'>('comment.created', (data) => {
    // eslint-disable-next-line no-console
    console.log('comment.created', data.commentId);
  });

  const unread = items.filter((item) => item.status === 'unread');

  return (
    <main>
      <h1>Netifly React example</h1>
      <p>
        connection status: <strong>{status}</strong> · unread notifications:{' '}
        <strong data-testid="unread-count">{unreadCount}</strong>
      </p>

      {/* aria-live="polite" per the WAI-ARIA alert pattern: new notifications
          are announced without stealing focus from whatever the user is doing. */}
      <section aria-live="polite" aria-label="Notifications">
        {unread.map((item) => (
          <article key={item.id} style={{ border: '1px solid #ccc', padding: 12, marginBottom: 8 }}>
            <strong>{item.notification.title}</strong>
            <p>{item.notification.body}</p>
            {item.notification.kind === 'action' ? (
              <div>
                {item.notification.actions.map((action) => (
                  <button
                    key={action.id}
                    onClick={() => {
                      void respond(item.id, action.id);
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : (
              <button onClick={() => markRead(item.id)}>Mark read</button>
            )}
            <button onClick={() => dismiss(item.id)}>Dismiss</button>
          </article>
        ))}
      </section>
    </main>
  );
}
