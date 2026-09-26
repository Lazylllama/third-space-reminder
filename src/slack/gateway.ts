import type { WebClient } from "@slack/web-api";
import type { Logger, SlackGateway } from "../deps";
import { isValidZone } from "../time/week";

/** Real Slack gateway. In dry-run mode DMs are logged instead of sent. */
export class WebSlackGateway implements SlackGateway {
  private readonly dmChannels = new Map<string, string>();

  constructor(
    private readonly client: WebClient,
    private readonly log: Logger,
    private readonly dryRun: boolean,
  ) {}

  async sendDm(slackId: string, message: { text: string; blocks?: unknown[] }): Promise<string | null> {
    if (this.dryRun) {
      this.log.info(`[dry run] DM to ${slackId}: ${message.text}`);
      return null;
    }
    const channel = await this.dmChannel(slackId);
    const res = await this.client.chat.postMessage({
      channel,
      text: message.text,
      ...(message.blocks ? { blocks: message.blocks as never } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
    return res.ts ?? null;
  }

  async userTimezone(slackId: string): Promise<string | null> {
    const res = await this.client.users.info({ user: slackId });
    const tz = res.user?.tz;
    return typeof tz === "string" && isValidZone(tz) ? tz : null;
  }

  private async dmChannel(slackId: string): Promise<string> {
    const cached = this.dmChannels.get(slackId);
    if (cached) return cached;
    const res = await this.client.conversations.open({ users: slackId });
    const id = res.channel?.id;
    if (!id) throw new Error(`couldn't open a DM with ${slackId}`);
    this.dmChannels.set(slackId, id);
    return id;
  }
}
