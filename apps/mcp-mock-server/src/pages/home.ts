export function renderHomePage(origin: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>iterate | mock-mcp-server</title>
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
      max-width: 800px;
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
    
    .url {
      background: #fafafa;
      border: 1px solid #e5e5e5;
      padding: 1rem;
      font-size: 12px;
      margin: 1rem 0;
      user-select: all;
    }
    
    .label {
      font-size: 10px;
      text-transform: uppercase;
      color: #999;
      margin-bottom: 0.5rem;
      margin-top: 1.5rem;
      letter-spacing: 0.1em;
      font-weight: 600;
    }
    
    ul {
      margin: 1rem 0;
      padding-left: 1.5rem;
    }
    
    li {
      margin: 0.5rem 0;
      font-size: 13px;
      color: #666;
      line-height: 1.6;
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
    
    .footer {
      margin-top: 3rem;
      padding-top: 2rem;
      border-top: 1px solid #e5e5e5;
      font-size: 12px;
      color: #999;
      text-align: center;
    }
    
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 3rem;
    }
    
    .header-left h1 {
      margin-bottom: 0.5rem;
    }
    
    .guide-btn {
      background: #000;
      color: #fff;
      border: none;
      padding: 0.75rem 1.5rem;
      cursor: pointer;
      font-family: 'SF Mono', 'Monaco', 'Menlo', monospace;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-weight: 600;
      margin-top: 0;
      transition: opacity 0.2s;
      text-decoration: none;
      display: inline-block;
    }
    
    .guide-btn:hover {
      opacity: 0.8;
    }
    
    .guide-btn:active {
      opacity: 0.6;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="header-left">
        <h1>iterate | mock-mcp-server</h1>
        <div class="subtitle">model context protocol testing server</div>
      </div>
      <a href="/docs" class="guide-btn">try guide</a>
    </div>

    <div class="section">
      <h2>no-auth mode</h2>
      <p>Direct MCP connection without authentication. Provides tools for testing deterministic operations, async behavior, error handling, and stateful CRUD operations.</p>
      
      <div class="label">endpoint</div>
      <div class="url">${origin}/mcp</div>
      
      <div class="label">available tool categories</div>
      <ul>
        <li>deterministic tools: echo, arithmetic operations, JSON echo</li>
        <li>async tools: delay, counter with timestamps</li>
        <li>error simulation: validation, runtime, not found, permission errors</li>
        <li>stateful CRUD: complete note management (create, read, update, delete, list)</li>
      </ul>
    </div>

    <div class="section">
      <h2>oauth mode</h2>
      <p>Full OAuth 2.1 with PKCE flow. Includes all base tools plus user-specific capabilities. Supports multiple authorization methods for different testing scenarios.</p>
      
      <div class="label">endpoint</div>
      <div class="url">${origin}/oauth/mcp</div>
      
      <div class="label">authorization methods</div>
      <ul>
        <li>interactive consent page with auto-generate or email/password login</li>
        <li>auto-approve mode: <code>?auto_approve=true</code> generates ephemeral user</li>
        <li>programmatic auth: <code>?auto_approve_email=...&auto_approve_password=...</code> for persistent users</li>
        <li>expiring tokens: <code>?expires_in=3600</code> for time-limited access</li>
      </ul>
      
      <div class="label">oauth-specific tools</div>
      <ul>
        <li>userInfo: retrieve authenticated user details</li>
        <li>greet: personalized greeting with formal/informal modes</li>
      </ul>
      
      <div class="label">user persistence</div>
      <ul>
        <li>programmatic auth users persist in KV storage across sessions</li>
        <li>same credentials authenticate as same user with consistent data</li>
        <li>auto-generated users are ephemeral and not stored</li>
      </ul>
    </div>

    <div class="footer">
      <a href="/health">health check</a> | 
      <a href="/docs">interactive guide</a> | 
      <a href="https://modelcontextprotocol.io" target="_blank">mcp spec</a>
    </div>
  </div>
</body>
</html>`;
}
