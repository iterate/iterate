export function renderConsentPage(
  requestUrl: string,
  clientId: string,
  errorMessage?: string,
): string {
  const url = new URL(requestUrl);
  const actionUrl = url.pathname + url.search;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>iterate | mock oauth authorization</title>
  <style>
    * { 
      margin: 0; 
      padding: 0; 
      box-sizing: border-box; 
    }
    
    body {
      font-family: 'SF Mono', 'Monaco', 'Menlo', monospace;
      background: #fff;
      color: #000;
      padding: 3rem 1.5rem;
      line-height: 1.5;
      font-size: 13px;
    }
    
    .container {
      max-width: 600px;
      margin: 0 auto;
    }
    
    h1 {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 0.5rem;
      letter-spacing: -0.01em;
    }
    
    .subtitle {
      color: #999;
      margin-bottom: 3rem;
      font-size: 13px;
      font-weight: 400;
    }
    
    .client-info {
      border: 1px solid #000;
      padding: 1.5rem;
      margin-bottom: 1rem;
      background: #fafafa;
    }
    
    .label {
      font-size: 10px;
      text-transform: uppercase;
      color: #999;
      margin-bottom: 0.5rem;
      letter-spacing: 0.1em;
      font-weight: 600;
    }
    
    .client-id {
      font-size: 12px;
      user-select: all;
      color: #666;
    }
    
    .section {
      border: 1px solid #000;
      padding: 2rem;
      margin-bottom: 1rem;
    }
    
    .section h2 {
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 1.5rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    
    .section p {
      margin-bottom: 1rem;
      color: #666;
      font-size: 13px;
      line-height: 1.6;
    }
    
    .form-group {
      margin-bottom: 1.5rem;
    }
    
    .form-group label {
      display: block;
      margin-bottom: 0.5rem;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #999;
      font-weight: 600;
    }
    
    input[type="email"],
    input[type="password"],
    input[type="number"] {
      width: 100%;
      padding: 0.75rem 1rem;
      border: 1px solid #e5e5e5;
      background: #fafafa;
      font-size: 12px;
      font-family: 'SF Mono', 'Monaco', 'Menlo', monospace;
      outline: none;
      transition: border-color 0.2s;
    }
    
    input:focus {
      border-color: #000;
    }
    
    button {
      width: 100%;
      padding: 0.75rem 1.5rem;
      border: none;
      background: #000;
      color: #fff;
      font-size: 11px;
      font-family: 'SF Mono', 'Monaco', 'Menlo', monospace;
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-weight: 600;
      transition: opacity 0.2s;
    }
    
    button:hover {
      opacity: 0.8;
    }
    
    button:active {
      opacity: 0.6;
    }
    
    button.btn-secondary {
      background: #fff;
      color: #000;
      border: 1px solid #000;
    }
    
    button.btn-secondary:hover {
      background: #000;
      color: #fff;
    }
    
    .divider {
      text-align: center;
      margin: 1.5rem 0;
      position: relative;
    }
    
    .divider::before {
      content: '';
      position: absolute;
      top: 50%;
      left: 0;
      right: 0;
      height: 1px;
      background: #e5e5e5;
    }
    
    .divider span {
      background: #fff;
      padding: 0 1rem;
      position: relative;
      color: #999;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    
    .error {
      border: 1px solid #e5e5e5;
      border-left: 2px solid #000;
      padding: 1.5rem;
      margin-bottom: 1rem;
      background: #fafafa;
    }
    
    .error-label {
      font-size: 10px;
      text-transform: uppercase;
      color: #000;
      margin-bottom: 0.5rem;
      letter-spacing: 0.1em;
      font-weight: 600;
    }
    
    .footer {
      margin-top: 3rem;
      padding-top: 2rem;
      border-top: 1px solid #e5e5e5;
      font-size: 12px;
      color: #999;
      text-align: center;
      line-height: 1.8;
    }
    
    code {
      background: #fafafa;
      border: 1px solid #e5e5e5;
      padding: 0.125rem 0.375rem;
      font-size: 11px;
      font-family: 'SF Mono', 'Monaco', 'Menlo', monospace;
    }
    
    a {
      color: #000;
      text-decoration: none;
      border-bottom: 1px solid #000;
    }
    
    a:hover {
      opacity: 0.6;
    }
    
    @media (max-width: 640px) {
      body {
        padding: 2rem 1rem;
        font-size: 12px;
      }
      
      .container {
        max-width: 100%;
      }
      
      h1 {
        font-size: 14px;
      }
      
      .subtitle {
        font-size: 12px;
        margin-bottom: 2rem;
      }
      
      .client-info {
        padding: 1rem;
      }
      
      .client-id {
        font-size: 11px;
        word-break: break-all;
      }
      
      .section {
        padding: 1.5rem;
        margin-bottom: 1rem;
      }
      
      .section p {
        font-size: 12px;
      }
      
      .form-group {
        margin-bottom: 1rem;
      }
      
      input[type="email"],
      input[type="password"] {
        font-size: 11px;
        padding: 0.75rem;
      }
      
      button {
        font-size: 10px;
        padding: 0.75rem 1rem;
      }
      
      .error {
        padding: 1rem;
      }
      
      .footer {
        font-size: 11px;
        margin-top: 2rem;
        padding-top: 1.5rem;
      }
      
      code {
        font-size: 10px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>iterate | mock oauth authorization</h1>
    <div class="subtitle">authorize application access</div>

    <div class="client-info">
      <div class="label">client requesting access</div>
      <div class="client-id">${clientId}</div>
    </div>

    ${errorMessage ? `<div class="error"><div class="error-label">error</div>${errorMessage}</div>` : ""}

    <div class="section">
      <h2>quick start</h2>
      <p>Generate a temporary test user and authorize immediately.</p>
      <form method="POST" action="${actionUrl}">
        <input type="hidden" name="action" value="auto">
        <input type="number" name="expires_in" min="60" placeholder="expires in (seconds)">
        <button type="submit" class="btn-secondary">authorize with auto-generated user</button>
      </form>
    </div>

    <div class="divider"><span>or</span></div>

    <div class="section">
      <h2>sign in</h2>
      <p>Use email and password. Creates a new user if email doesn't exist yet.</p>
      <form method="POST" action="${actionUrl}">
        <input type="hidden" name="action" value="login">
        <div class="form-group">
          <label for="email">email</label>
          <input type="email" id="email" name="email" required placeholder="user@example.com">
        </div>
        <div class="form-group">
          <label for="password">password</label>
          <input type="password" id="password" name="password" required placeholder="enter password">
        </div>
        <button type="submit">sign in &amp; authorize</button>
      </form>
    </div>

    <div class="footer">
      for automated tests: <code>?auto_approve=true</code> or <code>?auto_approve_email=...&amp;auto_approve_password=...</code><br>
      for expiring tokens: <code>?expires_in=3600</code><br>
      <a href="/guide">learn about oauth flow</a>
    </div>
  </div>
</body>
</html>`;
}
