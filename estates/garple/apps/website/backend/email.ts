import { Resend } from "resend";
import { eq } from "drizzle-orm";
import { env } from "../env.ts";
import { db } from "./db/client.ts";
import { domains, authCodes } from "./db/schema.ts";

const apiKey = env.RESEND_GARPLECOM_API_KEY;
if (!apiKey) {
  throw new Error("Resend API key is not set in environment variables.");
}

const resend = new Resend(apiKey);

interface DomainPurchaseEmailProps {
  domainNameWithTLD: string;
  authCode: string;
}

function generateDomainPurchaseEmail(props: DomainPurchaseEmailProps): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Your Domain Purchase - ${props.domainNameWithTLD}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
    }
    .header {
      text-align: center;
      margin-bottom: 30px;
    }
    .auth-code-box {
      background: #f5f5f5;
      border: 2px solid #ddd;
      border-radius: 8px;
      padding: 20px;
      margin: 20px 0;
      font-family: monospace;
      font-size: 18px;
      text-align: center;
      font-weight: bold;
    }
    .footer-text {
      color: #666;
      font-size: 14px;
      margin-top: 20px;
    }
    .logo {
      font-size: 24px;
      margin-bottom: 10px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">🌱 GARPLE</div>
  </div>
  
  <h1>Thank you for your purchase of <strong>${props.domainNameWithTLD}</strong>!</h1>
  
  <p>To receive the domain please reply to this email and we will take you through the process, or sit tight and we'll be in touch</p>
  
  <p class="footer-text">
    Best regards,<br>
    The Garple Team
  </p>
</body>
</html>
`.trim();
}

export async function sendDomainPurchaseEmail(domainId: string, customerEmail: string) {
  // Get domain details
  const domain = await db.select().from(domains).where(eq(domains.id, domainId)).limit(1);
  if (!domain[0]) {
    throw new Error("Domain not found");
  }

  // Get auth code
  const authCode = await db
    .select()
    .from(authCodes)
    .where(eq(authCodes.domainId, domainId))
    .limit(1);
  if (!authCode[0]) {
    throw new Error("Auth code not found");
  }

  const emailHtml = generateDomainPurchaseEmail({
    domainNameWithTLD: domain[0].nameWithTld,
    authCode: authCode[0].code,
  });

  const { data, error } = await resend.emails.send({
    from: "sales@garple.com",
    to: customerEmail,
    subject: `Your domain ${domain[0].nameWithTld} is ready!`,
    html: emailHtml,
  });

  if (error) {
    console.error("Failed to send email:", error);
    throw new Error("Failed to send email");
  }

  console.log("Email sent successfully:", data);
  return data;
}
