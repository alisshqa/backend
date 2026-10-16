import type { FastifyBaseLogger } from "fastify";

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface PushSender {
  send(messages: PushMessage[]): Promise<void>;
}

/** Development sender: writes notifications to the log. */
export class LogPushSender implements PushSender {
  constructor(private readonly log: FastifyBaseLogger) {}
  async send(messages: PushMessage[]): Promise<void> {
    for (const message of messages) this.log.info({ push: message }, "push notification (log provider)");
  }
}

/** Expo Push API — works for both iOS (APNs) and Android (FCM) when the client uses Expo. */
export class ExpoPushSender implements PushSender {
  constructor(
    private readonly log: FastifyBaseLogger,
    private readonly accessToken?: string,
  ) {}

  async send(messages: PushMessage[]): Promise<void> {
    // Expo accepts up to 100 messages per request.
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100).map((m) => ({ ...m, sound: "default" }));
      try {
        const response = await fetch("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
          },
          body: JSON.stringify(chunk),
        });
        if (!response.ok) this.log.warn({ status: response.status }, "expo push request failed");
      } catch (error) {
        this.log.warn({ err: error }, "expo push request failed");
      }
    }
  }
}
