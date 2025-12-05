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
      white-space: nowrap;
    }
    
    .guide-btn:hover {
      opacity: 0.8;
    }
    
    .guide-btn:active {
      opacity: 0.6;
    }
    
    .header-right {
      display: flex;
      gap: 1rem;
      align-items: center;
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
      }
      
      .header {
        flex-direction: column;
        gap: 1rem;
        margin-bottom: 2rem;
      }
      
      .header-right {
        flex-direction: column;
        width: 100%;
      }
      
      .guide-btn {
        width: 100%;
        text-align: center;
      }
      
      .section {
        padding: 1.5rem;
        margin-bottom: 1rem;
      }
      
      .url {
        font-size: 11px;
        padding: 0.75rem;
        word-break: break-all;
      }
      
      li {
        font-size: 12px;
      }
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
      <div class="header-right">
        <a class="github-button" href="https://github.com/iterate/iterate" data-color-scheme="no-preference: light; light: light; dark: dark;" data-size="large" data-show-count="true" aria-label="Star iterate/iterate on GitHub">Star</a>
        <a href="/guide" class="guide-btn">try guide</a>
      </div>
    </div>

    <div class="section">
      <h2>about</h2>
      <p>Building your own MCP client? Use our mock MCP for testing.</p>
      <p>Mock MCP server for end-to-end testing. Provides predictable, deterministic tools for testing MCP client implementations and integration workflows.</p>
    </div>

    <div class="section">
      <h2>no-auth mode</h2>
      <p>Simple MCP connection. No authentication required.</p>
      
      <div class="label">endpoint</div>
      <div class="url">${origin}/no-auth</div>
      
      <div class="label">available tools</div>
      <ul>
        <li>deterministic: echo, arithmetic, JSON</li>
        <li>async: delays and timestamps</li>
        <li>error simulation: various error types</li>
        <li>stateful CRUD: note management</li>
      </ul>
    </div>

    <div class="section">
      <h2>bearer mode</h2>
      <p>Bearer token required in Authorization header.</p>
      
      <div class="label">endpoint</div>
      <div class="url">${origin}/bearer</div>
      
      <div class="label">how to authenticate</div>
      <ul>
        <li>Send Authorization header: <code>Bearer &lt;token&gt;</code></li>
        <li>Optionally enforce a specific token by appending <code>?expected=&lt;token&gt;</code></li>
      </ul>
    </div>

    <div class="section">
      <h2>oauth mode</h2>
      <p>Full OAuth 2.1 flow with user authentication. Includes all no-auth tools plus user-specific tools.</p>
      
      <div class="label">endpoint</div>
      <div class="url">${origin}/oauth</div>
      
      <div class="label">how to authorize</div>
      <ul>
        <li>interactive: click through consent page (use for learning)</li>
        <li>auto-generated: <code>?auto_approve=true</code> (quick testing, user not saved)</li>
        <li>email/password: <code>?auto_approve_email=...&auto_approve_password=...</code> (user saved for reuse)</li>
        <li>expiring tokens: add <code>?expires_in=3600</code> to test token expiration</li>
      </ul>
      
      <div class="label">additional tools</div>
      <ul>
        <li>userInfo: get authenticated user details</li>
        <li>greet: personalized greeting</li>
      </ul>
    </div>

    <div class="footer">
      <a href="/health">health check</a> | 
      <a href="/guide">interactive guide</a> | 
      <a href="https://modelcontextprotocol.io" target="_blank">mcp spec</a>
    </div>
  </div>
  <script async defer src="https://buttons.github.io/buttons.js"></script>
</body>
</html>`;
}
