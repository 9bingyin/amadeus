import { parseArgs } from "node:util";
import { z } from "zod";
import { notificationSchema, receiptSchema } from "./protocol";

const environmentSchema = z.object({
  AMADEUS_NOTIFY_SOCKET: z.string().min(1),
  AMADEUS_NOTIFY_TOKEN: z.string().min(1),
});

export async function notify(
  notification: z.input<typeof notificationSchema>,
  environment: Record<string, string | undefined> = process.env,
) {
  const settings = environmentSchema.parse(environment);
  using client = new Bun.FetchSession({ unix: settings.AMADEUS_NOTIFY_SOCKET });
  const response = await client.fetch("http://localhost/notify", {
    method: "POST",
    headers: {
      authorization: `Bearer ${settings.AMADEUS_NOTIFY_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(notificationSchema.parse(notification)),
  });
  if (!response.ok)
    throw { status: response.status, error: await response.text() };
  return receiptSchema.parse(await response.json());
}

export async function notifyCli(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      key: { type: "string" },
      message: { type: "string" },
      data: { type: "string" },
    },
  });
  const notification = notificationSchema.parse({
    eventKey: values.key,
    message: values.message,
    data: JSON.parse(values.data ?? "null"),
  });
  console.log(JSON.stringify(await notify(notification)));
}

if (import.meta.main) {
  notifyCli(Bun.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
