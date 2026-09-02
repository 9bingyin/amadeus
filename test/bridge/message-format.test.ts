import { describe, expect, test } from "bun:test";
import { formatPiMessage } from "../../src/bridge/message-format";
import type { IndexedTelegramMessage } from "../../src/telegram/types";

describe("formatPiMessage", () => {
  test("把 XML 元数据放在正文上一行", () => {
    expect(
      formatPiMessage(
        {
          messageId: 187,
          sentAt: "2026-09-01T15:39:54Z",
        },
        "这是什么",
      ),
    ).toBe('<tg id="187" t="2026-09-01T15:39:54Z"/>\n这是什么');
  });

  test("保留转发来源、引用和选区，但不包裹正文", () => {
    expect(
      formatPiMessage(
        {
          messageId: 191,
          sentAt: "2026-09-01T16:10:56Z",
          forward: {
            kind: "channel",
            id: -1001234567890,
            title: "示例科技频道",
            username: "example_channel",
            messageId: 42,
            sentAt: "2026-09-01T13:58:44Z",
          },
          reply: {
            messageId: 189,
            quote: "这是一段用于测试的引用文本",
          },
        },
        "test",
      ),
    ).toBe(
      '<tg id="191" t="2026-09-01T16:10:56Z" fwd="channel:@example_channel/42" orig="2026-09-01T13:58:44Z" reply="189"><q>这是一段用于测试的引用文本</q></tg>\ntest',
    );
  });

  test("只转义 XML 属性和子节点，不转义原始正文", () => {
    const formatted = formatPiMessage(
      {
        messageId: 1,
        sentAt: "2026-09-01T00:00:00Z",
        sender: 'A&B"C',
        reply: { quote: "x < y & z" },
      },
      "raw <body> & text",
    );

    expect(formatted).toContain('by="A&amp;B&quot;C"');
    expect(formatted).toContain("<q>x &lt; y &amp; z</q>");
    expect(formatted).toEndWith("\nraw <body> & text");
  });

  test("未知引用目标只在需要时补充归一化内容", () => {
    const reference = {
      messageId: 189,
      role: "user",
      piSessionId: "old-session",
      sentAt: "2026-09-01T15:48:59Z",
      text: "A < B & C",
      attachments: [
        {
          kind: "photo",
          fileId: "file",
          fileUniqueId: "unique",
          width: 868,
          height: 488,
          localPath: "/safe/image.jpg",
        },
      ],
    } satisfies IndexedTelegramMessage;

    expect(
      formatPiMessage(
        {
          messageId: 192,
          sentAt: "2026-09-01T16:12:00Z",
          reply: { messageId: 189, reference },
        },
        "继续看这个",
      ),
    ).toContain(
      '<ref role="user" id="189" media="photo"><text>A &lt; B &amp; C</text><file kind="photo" name="unique.jpg" status="available" path="/safe/image.jpg" mime="image/jpeg" width="868" height="488"/></ref>',
    );
  });

  test("格式化 poll、contact 和 story 结构化内容", () => {
    const poll = formatPiMessage(
      {
        messageId: 2,
        sentAt: "2026-09-01T00:00:00Z",
        content: {
          kind: "poll",
          question: "A < B?",
          options: [
            { text: "是 & 否", voterCount: 3 },
            { text: "未知", voterCount: 1 },
          ],
          totalVoterCount: 4,
          closed: false,
          anonymous: true,
          pollType: "regular",
          multipleAnswers: false,
          allowsRevoting: true,
          membersOnly: false,
          openPeriod: 60,
          closeDate: 1_788_280_000,
          media: [
            {
              kind: "link",
              section: "description",
              url: "https://example.com/poll?a=1&b=2",
            },
            {
              kind: "location",
              section: "explanation",
              latitude: 31.2,
              longitude: 121.5,
            },
            {
              kind: "venue",
              section: "option",
              optionIndex: 1,
              latitude: 40.7,
              longitude: -74,
              title: "Venue",
              address: "Address",
            },
          ],
        },
      },
      "",
    );
    expect(poll).toContain('kind="poll" question="A &lt; B?"');
    expect(poll).toContain('open_period="60" close_date="1788280000"');
    expect(poll).toContain('<option index="0" voters="3">是 &amp; 否</option>');
    expect(poll).toContain(
      'section="description" kind="link" url="https://example.com/poll?a=1&amp;b=2"',
    );
    expect(poll).toContain(
      'section="explanation" kind="location" latitude="31.2" longitude="121.5"',
    );
    expect(poll).toContain(
      'section="option" option="1" kind="venue" latitude="40.7" longitude="-74"',
    );

    const contact = formatPiMessage(
      {
        messageId: 3,
        sentAt: "2026-09-01T00:00:00Z",
        content: {
          kind: "contact",
          phoneNumber: "+123",
          firstName: "A&B",
          vcard: "BEGIN:VCARD\n<x>",
        },
      },
      "",
    );
    expect(contact).toContain('kind="contact" phone="+123" first="A&amp;B"');
    expect(contact).toContain("<vcard>BEGIN:VCARD\n&lt;x&gt;</vcard>");

    expect(
      formatPiMessage(
        {
          messageId: 4,
          sentAt: "2026-09-01T00:00:00Z",
          content: { kind: "story", chatId: 10, storyId: 20 },
        },
        "",
      ),
    ).toContain(
      'kind="story" chat="10" story="20" status="unavailable" reason="content_unavailable"',
    );
    expect(
      formatPiMessage(
        {
          messageId: 5,
          sentAt: "2026-09-01T00:00:00Z",
          content: {
            kind: "paid_media",
            starCount: 10,
            itemCount: 2,
            unavailableItemCount: 1,
            previews: [{ index: 0, width: 640, height: 360, duration: 5 }],
          },
        },
        "",
      ),
    ).toContain(
      'kind="paid_media" stars="10" items="2" unavailable="1" reason="content_unavailable"',
    );
    expect(
      formatPiMessage(
        {
          messageId: 5,
          sentAt: "2026-09-01T00:00:00Z",
          content: {
            kind: "paid_media",
            starCount: 10,
            itemCount: 1,
            unavailableItemCount: 1,
            previews: [{ index: 0, width: 640, height: 360, duration: 5 }],
          },
        },
        "",
      ),
    ).toContain(
      '<preview index="0" status="unavailable" reason="content_unavailable" width="640" height="360" duration="5"/>',
    );
    expect(
      formatPiMessage(
        {
          messageId: 6,
          sentAt: "2026-09-01T00:00:00Z",
          content: {
            kind: "rich_message",
            blockTypes: ["future_block"],
            unavailableBlockCount: 1,
            unavailableReasons: ["unsupported_nested_type"],
          },
        },
        "",
      ),
    ).toContain(
      'kind="rich_message" blocks="future_block" unavailable="1" reason="unsupported_nested_type"',
    );
  });

  test("格式化其余结构化内容", () => {
    const metadata = {
      messageId: 10,
      sentAt: "2026-09-01T00:00:00Z",
    } as const;

    expect(
      formatPiMessage(
        { ...metadata, content: { kind: "dice", emoji: "dice", value: 6 } },
        "",
      ),
    ).toContain('kind="dice" emoji="dice" value="6"');
    expect(
      formatPiMessage(
        {
          ...metadata,
          content: {
            kind: "game",
            title: "Game",
            description: "A&B",
            text: "Play <now>",
          },
        },
        "",
      ),
    ).toContain(
      'kind="game" title="Game" description="A&amp;B"><text>Play &lt;now&gt;</text>',
    );
    expect(
      formatPiMessage(
        {
          ...metadata,
          content: {
            kind: "venue",
            latitude: 31.2,
            longitude: 121.5,
            title: "Office",
            address: "Road",
          },
        },
        "",
      ),
    ).toContain(
      'kind="venue" latitude="31.2" longitude="121.5" title="Office" address="Road"',
    );
    expect(
      formatPiMessage(
        {
          ...metadata,
          content: {
            kind: "checklist",
            title: "Release",
            tasks: [
              {
                id: 1,
                text: "Test & ship",
                completed: true,
                completionDate: 1_788_280_000,
                completedByUserId: 42,
                completedByChatId: -100,
              },
            ],
            othersCanAddTasks: false,
            othersCanMarkTasksDone: true,
          },
        },
        "",
      ),
    ).toContain(
      '<task id="1" completed="true" completion_date="1788280000" completed_by_user="42" completed_by_chat="-100">Test &amp; ship</task>',
    );
    expect(
      formatPiMessage(
        {
          ...metadata,
          content: {
            kind: "rich_message",
            blockTypes: ["heading", "photo"],
          },
        },
        "body",
      ),
    ).toContain('kind="rich_message" blocks="heading,photo"');
  });

  test("字段缺失时输出原内容类型和 unavailable 原因", () => {
    expect(
      formatPiMessage(
        {
          messageId: 11,
          sentAt: "2026-09-01T00:00:00Z",
          content: {
            kind: "unavailable",
            contentKind: "photo",
            reasons: ["missing_fields"],
          },
        },
        "caption",
      ),
    ).toBe(
      '<tg id="11" t="2026-09-01T00:00:00Z"><content kind="photo" status="unavailable" reason="missing_fields"/></tg>\ncaption',
    );
  });

  test("把扩展媒体元数据写入 file 节点", () => {
    expect(
      formatPiMessage(
        {
          messageId: 5,
          sentAt: "2026-09-01T00:00:00Z",
          content: { kind: "video" },
          files: [
            {
              kind: "video",
              name: "clip.mp4",
              status: "available",
              path: "/safe/clip.mp4",
              mimeType: "video/mp4",
              size: 100,
              width: 1920,
              height: 1080,
              duration: 30,
              source: "poll",
              sourceSection: "option",
              sourceIndex: 1,
            },
          ],
        },
        "caption",
      ),
    ).toContain(
      '<file kind="video" name="clip.mp4" status="available" path="/safe/clip.mp4" mime="video/mp4" size="100" source="poll" section="option" index="1" width="1920" height="1080" duration="30"/>',
    );
  });

  test("把不可用附件原因写入元数据", () => {
    expect(
      formatPiMessage(
        {
          messageId: 2,
          sentAt: "2026-09-01T00:00:00Z",
          files: [
            {
              kind: "document",
              name: "large.zip",
              status: "unavailable",
              reason: "telegram_public_api_limit",
              limitBytes: 20 * 1024 * 1024,
              size: 21 * 1024 * 1024,
            },
          ],
        },
        "请分析这个文件",
      ),
    ).toContain(
      '<file kind="document" name="large.zip" status="unavailable" reason="telegram_public_api_limit" limit="20971520" size="22020096"/>',
    );
  });
});
