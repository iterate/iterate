export function renderDocsPage(requestUrl: string): string {
  const url = new URL(requestUrl);
  const origin = url.origin;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>iterate | mock oauth interactive guide</title>
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
    
    .label {
      font-size: 10px;
      text-transform: uppercase;
      color: #999;
      margin-bottom: 0.5rem;
      margin-top: 1.5rem;
      letter-spacing: 0.1em;
      font-weight: 600;
    }
    
    .endpoint {
      background: #fafafa;
      border: 1px solid #e5e5e5;
      padding: 1rem;
      margin-bottom: 0.5rem;
      font-size: 12px;
      font-family: 'SF Mono', 'Monaco', 'Menlo', monospace;
    }
    
    .method {
      display: inline-block;
      background: #000;
      color: #fff;
      padding: 0.25rem 0.5rem;
      margin-right: 0.75rem;
      font-size: 10px;
      font-weight: 600;
      min-width: 3rem;
      text-align: center;
      letter-spacing: 0.05em;
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 1.5rem 0;
      font-size: 12px;
    }
    
    th {
      text-align: left;
      padding: 0.75rem;
      background: #fafafa;
      border: 1px solid #e5e5e5;
      font-weight: 600;
      text-transform: uppercase;
      font-size: 10px;
      letter-spacing: 0.1em;
    }
    
    td {
      padding: 0.75rem;
      border: 1px solid #e5e5e5;
      vertical-align: top;
      line-height: 1.6;
    }
    
    code {
      background: #fafafa;
      border: 1px solid #e5e5e5;
      padding: 0.125rem 0.375rem;
      font-size: 11px;
      font-family: 'SF Mono', 'Monaco', 'Menlo', monospace;
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
    
    .footer {
      margin-top: 3rem;
      padding-top: 2rem;
      border-top: 1px solid #e5e5e5;
      font-size: 12px;
      color: #999;
      text-align: center;
    }
    
    a {
      color: #000;
      text-decoration: none;
      border-bottom: 1px solid #000;
    }
    
    a:hover {
      opacity: 0.6;
    }
    
    .section.locked {
      opacity: 0.3;
      pointer-events: none;
    }
    
    .section.locked::after {
      content: 'Complete previous step to unlock';
      display: block;
      text-align: center;
      margin-top: 2rem;
      font-size: 11px;
      color: #999;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    
    button {
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
      margin-top: 1.5rem;
      transition: opacity 0.2s;
    }
    
    button:hover {
      opacity: 0.8;
    }
    
    button:active {
      opacity: 0.6;
    }
    
    button:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }
    
    .result-box {
      background: #fafafa;
      border: 1px solid #e5e5e5;
      padding: 1.5rem;
      margin-top: 1.5rem;
      font-size: 12px;
    }
    
    .result-box pre {
      margin: 0;
      background: none;
      border: none;
      padding: 0;
      white-space: pre-wrap;
      word-break: break-all;
      color: #666;
      line-height: 1.6;
    }
    
    .success {
      border-left: 2px solid #000;
    }
    
    .error {
      border-left: 2px solid #000;
    }
    
    input {
      padding: 0.75rem 1rem;
      border: 1px solid #e5e5e5;
      background: #fafafa;
      font-family: 'SF Mono', 'Monaco', 'Menlo', monospace;
      font-size: 12px;
      margin-right: 0.5rem;
      outline: none;
      transition: border-color 0.2s;
    }
    
    input:focus {
      border-color: #000;
    }
    
    .step-status {
      display: inline-block;
      margin-left: 0.5rem;
      font-size: 11px;
    }
    
    .step-status.completed::before {
      content: '✓';
      margin-right: 0.25rem;
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
    
    .reset-btn {
      background: #fff;
      color: #000;
      border: 1px solid #000;
      padding: 0.75rem 1.5rem;
      cursor: pointer;
      font-family: 'SF Mono', 'Monaco', 'Menlo', monospace;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-weight: 600;
      margin-top: 0;
      transition: all 0.2s;
    }
    
    .reset-btn:hover {
      background: #000;
      color: #fff;
    }
    
    .action-btn.hidden {
      display: none;
    }
    
    .header-right {
      display: flex;
      gap: 1rem;
      align-items: center;
    }
    
    .disclaimer {
      background: #fafafa;
      border: 1px solid #e5e5e5;
      padding: 1.5rem;
      margin-bottom: 3rem;
      font-size: 12px;
      color: #666;
      line-height: 1.6;
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
      
      .reset-btn {
        width: 100%;
        text-align: center;
      }
      
      .section {
        padding: 1.5rem;
        margin-bottom: 1rem;
      }
      
      .disclaimer {
        padding: 1rem;
        margin-bottom: 2rem;
        font-size: 11px;
      }
      
      .endpoint {
        font-size: 11px;
        padding: 0.75rem;
        word-break: break-all;
      }
      
      .method {
        display: block;
        margin-bottom: 0.5rem;
        margin-right: 0;
      }
      
      table {
        font-size: 11px;
      }
      
      th, td {
        padding: 0.5rem;
      }
      
      input {
        font-size: 11px;
        padding: 0.75rem;
      }
      
      input#redirect-uri {
        width: 100% !important;
        margin-bottom: 0.5rem;
      }
      
      button {
        width: 100%;
        padding: 0.75rem 1rem;
      }
      
      .result-box {
        font-size: 11px;
        padding: 1rem;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="header-left">
        <h1>iterate | mock oauth server</h1>
        <div class="subtitle">interactive oauth 2.1 guide</div>
      </div>
      <div class="header-right">
        <a class="github-button" href="https://github.com/iterate/iterate" data-color-scheme="no-preference: light; light: light; dark: dark;" data-size="large" data-show-count="true" aria-label="Star iterate/iterate on GitHub">Star</a>
        <button class="reset-btn" onclick="resetProgress()">reset guide</button>
      </div>
    </div>

    <div class="disclaimer">
      Walk through the OAuth 2.1 flow step by step. This is what happens behind the scenes when an MCP client connects to an OAuth server. Each step unlocks after you complete it.
    </div>

    <div class="section" id="step-1">
      <h2>step 1: server discovery</h2>
      <div class="endpoint"><span class="method get">GET</span>${origin}/.well-known/oauth-authorization-server</div>
      <p>First, the client discovers what the server supports.</p>
      <button class="action-btn" onclick="window.open('${origin}/.well-known/oauth-authorization-server', '_blank')">View Server Metadata</button>
    </div>

    <div class="section" id="step-2">
      <h2>step 2: client registration<span class="step-status" id="status-2"></span></h2>
      <div class="endpoint"><span class="method post">POST</span>${origin}/oauth/register</div>
      <p>Register your client to get a unique client ID.</p>
      
      <div class="label">redirect uri</div>
      <input type="text" id="redirect-uri" class="inline-input" value="${origin}/guide" style="width: 300px;" readonly>
      <button class="action-btn" id="register-btn" onclick="registerClient()">Register Client</button>
      <div id="registration-result"></div>
    </div>

    <div class="section locked" id="step-3">
      <h2>step 3: authorization<span class="step-status" id="status-3"></span></h2>
      <div class="endpoint"><span class="method get">GET</span>${origin}/oauth/authorize</div>
      <div class="endpoint"><span class="method post">POST</span>${origin}/oauth/authorize</div>
      <p>Request authorization from a user. You'll see a consent page where users can approve access.</p>

      <div class="label">query parameters (GET)</div>
      <table>
        <tr>
          <th>parameter</th>
          <th>description</th>
        </tr>
        <tr>
          <td><code>client_id</code></td>
          <td>OAuth client ID (required)</td>
        </tr>
        <tr>
          <td><code>redirect_uri</code></td>
          <td>Callback URL (required)</td>
        </tr>
        <tr>
          <td><code>state</code></td>
          <td>CSRF protection token (required)</td>
        </tr>
        <tr>
          <td><code>code_challenge</code></td>
          <td>PKCE challenge (required)</td>
        </tr>
        <tr>
          <td><code>auto_approve</code></td>
          <td>Set to <code>true</code> to skip consent and auto-generate user</td>
        </tr>
        <tr>
          <td><code>auto_approve_email</code></td>
          <td>Email for programmatic auth (requires password)</td>
        </tr>
        <tr>
          <td><code>auto_approve_password</code></td>
          <td>Password for programmatic auth (requires email)</td>
        </tr>
        <tr>
          <td><code>expires_in</code></td>
          <td>Token expiration in seconds (optional, default: no expiration)</td>
        </tr>
      </table>

      <div class="label">form fields (POST - consent page)</div>
      <table>
        <tr>
          <th>field</th>
          <th>description</th>
        </tr>
        <tr>
          <td><code>action</code></td>
          <td><code>auto</code> (generate user) or <code>login</code> (email/password)</td>
        </tr>
        <tr>
          <td><code>email</code></td>
          <td>Email (required when <code>action=login</code>)</td>
        </tr>
        <tr>
          <td><code>password</code></td>
          <td>Password (required when <code>action=login</code>)</td>
        </tr>
      </table>

      <button class="action-btn" id="authorize-btn" onclick="authorize()">Start Authorization</button>
      <div id="authorization-result"></div>
    </div>

    <div class="section locked" id="step-4">
      <h2>step 4: token exchange<span class="step-status" id="status-4"></span></h2>
      <div class="endpoint"><span class="method post">POST</span>${origin}/oauth/token</div>
      <p>Exchange the authorization code for an access token.</p>
      <button class="action-btn" id="token-btn" onclick="exchangeToken()">Exchange for Token</button>
      <div id="token-result"></div>
    </div>

    <div class="section locked" id="step-5">
      <h2>step 5: you're done!</h2>
      <div class="endpoint"><span class="method get">GET/POST</span>${origin}/oauth/mcp</div>
      <p>That's the complete OAuth flow. MCP clients do all of this automatically—you just experienced what happens behind the scenes.</p>
      <p>Building your own MCP client? Use our mock MCP for testing.</p>
      <div class="result-box success" id="completion-message" style="display: none;">
        Guide complete. You now understand how OAuth works with MCP.
      </div>
    </div>

    <div class="section">
      <h2>reference</h2>
      
      <div class="label">no-auth endpoint</div>
      <div class="endpoint"><span class="method get">GET/POST</span>${origin}/mcp</div>
      <p>Simple endpoint with no authentication.</p>

      <div class="label">other endpoints</div>
      <div class="endpoint"><span class="method get">GET</span>${origin}/</div>
      <p>Server information</p>
      <div class="endpoint"><span class="method get">GET</span>${origin}/health</div>
      <p>JSON health check</p>
      
      <div class="label">user persistence</div>
      <p>Users created with email/password are saved. Auto-generated users are temporary.</p>
    </div>

    <div class="footer">
      <a href="${origin}/">home</a> | 
      <a href="${origin}/health">health check</a> | 
      <a href="https://modelcontextprotocol.io" target="_blank">mcp spec</a>
    </div>
  </div>

  <script>
    const ORIGIN = '${origin}';
    const SESSION_KEY = 'oauth_session';

    function getSession() {
      const data = localStorage.getItem(SESSION_KEY);
      return data ? JSON.parse(data) : {};
    }

    function saveSession(updates) {
      const session = { ...getSession(), ...updates };
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      return session;
    }

    function unlockStep(stepNum) {
      const step = document.getElementById(\`step-\${stepNum}\`);
      if (step) {
        step.classList.remove('locked');
        setTimeout(() => {
          step.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 300);
      }
      const status = document.getElementById(\`status-\${stepNum - 1}\`);
      if (status) {
        status.className = 'step-status completed';
      }
    }

    function showResult(elementId, content, isError = false) {
      const el = document.getElementById(elementId);
      el.innerHTML = \`<div class="result-box \${isError ? 'error' : 'success'}"><pre>\${content}</pre></div>\`;
    }

    async function registerClient() {
      const redirectUri = document.getElementById('redirect-uri').value;
      try {
        const response = await fetch(\`\${ORIGIN}/oauth/register\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            redirect_uris: [redirectUri],
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code'],
          }),
        });
        const data = await response.json();
        
        saveSession({
          client_id: data.client_id,
          redirect_uri: redirectUri,
        });
        
        showResult('registration-result', JSON.stringify(data, null, 2));
        document.getElementById('register-btn').classList.add('hidden');
        unlockStep(3);
      } catch (error) {
        showResult('registration-result', \`Error: \${error.message}\`, true);
      }
    }

    function generatePKCE() {
      const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
      
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
        .then(hash => {
          const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
            .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
          return { verifier, challenge };
        });
    }

    async function authorize() {
      const session = getSession();
      if (!session.client_id) {
        showResult('authorization-result', 'Error: Please register a client first', true);
        return;
      }

      try {
        const pkce = await generatePKCE();
        const state = btoa(Math.random().toString()).substring(0, 16);
        
        saveSession({
          code_verifier: pkce.verifier,
          state: state,
        });

        const params = new URLSearchParams({
          client_id: session.client_id,
          redirect_uri: session.redirect_uri,
          response_type: 'code',
          state: state,
          code_challenge: pkce.challenge,
          code_challenge_method: 'S256',
        });

        const authUrl = \`\${ORIGIN}/oauth/authorize?\${params}\`;
        window.location.href = authUrl;
      } catch (error) {
        showResult('authorization-result', \`Error: \${error.message}\`, true);
      }
    }

    function handleOAuthCallback() {
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get('code');
      const state = urlParams.get('state');

      if (code) {
        const session = getSession();
        
        if (state && state !== session.state) {
          showResult('authorization-result', 'Error: State mismatch - possible CSRF attack', true);
          return;
        }

        saveSession({ authorization_code: code });
        showResult('authorization-result', \`Authorization successful!\\n\\nAuthorization Code: \${code}\`);
        document.getElementById('authorize-btn').classList.add('hidden');
        unlockStep(4);

        const cleanUrl = window.location.pathname;
        window.history.replaceState({}, '', cleanUrl);
      }
    }

    async function exchangeToken() {
      const session = getSession();
      if (!session.authorization_code) {
        showResult('token-result', 'Error: Please complete authorization first', true);
        return;
      }

      try {
        const params = new URLSearchParams({
          grant_type: 'authorization_code',
          code: session.authorization_code,
          client_id: session.client_id,
          code_verifier: session.code_verifier,
        });

        const response = await fetch(\`\${ORIGIN}/oauth/token\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params,
        });

        const data = await response.json();
        saveSession({ access_token: data.access_token });
        
        showResult('token-result', JSON.stringify(data, null, 2));
        document.getElementById('token-btn').classList.add('hidden');
        unlockStep(5);
        document.getElementById('completion-message').style.display = 'block';
      } catch (error) {
        showResult('token-result', \`Error: \${error.message}\`, true);
      }
    }

    function resetProgress() {
      if (confirm('Reset all progress? This will clear your session data.')) {
        localStorage.removeItem(SESSION_KEY);
        location.reload();
      }
    }

    // Restore progress on page load
    window.addEventListener('DOMContentLoaded', () => {
      handleOAuthCallback();
      
      const session = getSession();
      if (session.client_id) {
        document.getElementById('redirect-uri').value = session.redirect_uri || '${origin}/guide';
        showResult('registration-result', \`Client registered!\\n\\nClient ID: \${session.client_id}\`);
        document.getElementById('register-btn').classList.add('hidden');
        unlockStep(3);
      }
      if (session.authorization_code) {
        unlockStep(3);
        unlockStep(4);
        showResult('authorization-result', \`Authorization successful!\\n\\nAuthorization Code: \${session.authorization_code}\`);
        document.getElementById('authorize-btn').classList.add('hidden');
      }
      if (session.access_token) {
        unlockStep(5);
        showResult('token-result', \`Access token obtained!\\n\\nToken: \${session.access_token}\`);
        document.getElementById('token-btn').classList.add('hidden');
        document.getElementById('completion-message').style.display = 'block';
      }
    });
  </script>
  <script async defer src="https://buttons.github.io/buttons.js"></script>
</body>
</html>`;
}
