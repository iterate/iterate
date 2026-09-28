// apps/iterate-com-inbound-email — iterate.com's inbound mail. The Email Routing catch-all on the
// iterate.com zone delivers every message for *@iterate.com here, and for now each one is forwarded
// to Jonas. `forward` reaches only a destination address verified on the account (Email Routing →
// Destination addresses).
export default {
  async email(message: ForwardableEmailMessage) {
    try {
      await message.forward("jonas@nustom.com");
    } catch (error) {
      // Email Routing forwards only mail that passes SPF or DKIM, and says so with this message.
      // That refusal is permanent, so the sender gets a bounce now instead of retrying for days;
      // any other failure is ours and stays temporary, so the sender retries.
      if (!String(error).includes("non-authenticated emails cannot be forwarded")) throw error;
      message.setReject("iterate.com accepts only mail that passes SPF or DKIM.");
    }
  },
} satisfies ExportedHandler;
