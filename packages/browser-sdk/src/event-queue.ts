import type { AnalyticsEventSchema } from '@signaltrail/contracts';
import { openDB, type DBSchema } from 'idb';

type AnalyticsEvent = ReturnType<typeof AnalyticsEventSchema.parse>;

interface QueueDatabase extends DBSchema {
  events: {
    key: number;
    value: AnalyticsEvent;
    indexes: {
      byEventId: string;
    };
  };
}

type EnqueueResult = { status: 'queued' } | { status: 'dropped'; reason: 'capacity' };

interface EventQueueOptions {
  maxEvents?: number;
}

export interface EventQueue {
  enqueue(event: AnalyticsEvent): Promise<EnqueueResult>;
  getAll(): Promise<AnalyticsEvent[]>;
  close(): void;
}

export async function openEventQueue(
  databaseName: string,
  options: EventQueueOptions = {},
): Promise<EventQueue> {
  const maxEvents = options.maxEvents ?? 500;
  const versionNumber = 1;
  const database = await openDB<QueueDatabase>(databaseName, versionNumber, {
    upgrade(database) {
      const store = database.createObjectStore('events', {
        autoIncrement: true,
      });
      store.createIndex('byEventId', 'eventId', {
        unique: true,
      });
    },
  });

  return {
    async enqueue(event): Promise<EnqueueResult> {
      const transaction = database.transaction('events', 'readwrite');
      const count = await transaction.store.count();
      if (count >= maxEvents) {
        await transaction.done;
        return {
          status: 'dropped',
          reason: 'capacity',
        };
      }

      await transaction.store.add(event);
      await transaction.done;

      return { status: 'queued' };
    },
    getAll() {
      return database.getAll('events');
    },
    close() {
      database.close();
    },
  };
}
