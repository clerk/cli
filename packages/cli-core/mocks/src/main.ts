const app = document.getElementById("app")!;

// Read callback port from URL params (set by the CLI)
const params = new URLSearchParams(window.location.search);
const callbackPort = params.get("callback_port");

type AppScreen = "sign-in" | "sign-up" | "select-app" | "success-new" | "success-existing";

function render(screen: AppScreen) {
  switch (screen) {
    case "sign-in":
      return renderSignIn();
    case "sign-up":
      return renderSignUp();
    case "select-app":
      return renderSelectApp();
    case "success-new":
      return renderSuccess("new");
    case "success-existing":
      return renderSuccess("existing");
  }
}

async function notifyCLI(isNewUser: boolean) {
  if (!callbackPort) return;
  await fetch(`http://localhost:${callbackPort}/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isNewUser }),
  });
}

function renderSignIn() {
  app.innerHTML = `
    <div class="card">
      <h1>Sign in to Clerk</h1>
      <p class="subtitle">Welcome back! Sign in to continue to the CLI.</p>
      <form id="sign-in-form">
        <div class="field">
          <label>Email address</label>
          <input type="text" placeholder="you@example.com" />
        </div>
        <div class="field">
          <label>Password</label>
          <input type="password" placeholder="Enter your password" />
        </div>
        <button type="submit" class="btn btn-primary">Sign in</button>
      </form>
      <div class="toggle">
        Don't have an account? <a id="go-sign-up">Sign up</a>
      </div>
    </div>
  `;

  document.getElementById("sign-in-form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    render("select-app");
  });

  document.getElementById("go-sign-up")!.addEventListener("click", () => {
    render("sign-up");
  });
}

function renderSignUp() {
  app.innerHTML = `
    <div class="card">
      <h1>Create your account</h1>
      <p class="subtitle">Sign up to get started with Clerk.</p>
      <form id="sign-up-form">
        <div class="field">
          <label>Email address</label>
          <input type="text" placeholder="you@example.com" />
        </div>
        <div class="field">
          <label>Password</label>
          <input type="password" placeholder="Create a password" />
        </div>
        <button type="submit" class="btn btn-primary">Create account</button>
      </form>
      <div class="toggle">
        Already have an account? <a id="go-sign-in">Sign in</a>
      </div>
    </div>
  `;

  document.getElementById("sign-up-form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    notifyCLI(true);
    render("success-new");
  });

  document.getElementById("go-sign-in")!.addEventListener("click", () => {
    render("sign-in");
  });
}

function renderSelectApp() {
  const apps = [
    { name: "my-saas-app", id: "app_2xBk9mT3gP" },
    { name: "staging-app", id: "app_8nRq4kW1vL" },
    { name: "dev-playground", id: "app_5jFm7hY2cN" },
  ];

  app.innerHTML = `
    <div class="card">
      <h1>Select an app</h1>
      <p class="subtitle">Choose an existing app to link, or create a new one.</p>
      <ul class="app-list" id="app-list">
        ${apps
          .map(
            (a) => `
          <li data-id="${a.id}">
            <div class="app-name">${a.name}</div>
            <div class="app-id">${a.id}</div>
          </li>
        `,
          )
          .join("")}
      </ul>
      <button id="link-btn" class="btn btn-primary" disabled>Link app</button>
      <div class="divider">or</div>
      <button id="create-btn" class="btn btn-secondary">Create a new app</button>
    </div>
  `;

  let selected: string | null = null;
  const linkBtn = document.getElementById("link-btn") as HTMLButtonElement;

  document.getElementById("app-list")!.addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest("li");
    if (!li) return;
    document.querySelectorAll(".app-list li").forEach((el) => el.classList.remove("selected"));
    li.classList.add("selected");
    selected = li.dataset.id!;
    linkBtn.disabled = false;
  });

  linkBtn.addEventListener("click", () => {
    if (selected) {
      notifyCLI(false);
      render("success-existing");
    }
  });

  document.getElementById("create-btn")!.addEventListener("click", () => {
    notifyCLI(false);
    render("success-new");
  });
}

function renderSuccess(type: "new" | "existing") {
  const appName = type === "new" ? "my-clerk-app" : "my-saas-app";

  app.innerHTML = `
    <div class="card">
      <div class="success-icon">&#10003;</div>
      <h1 style="text-align:center">${type === "new" ? "App created" : "App linked"}</h1>
      <p class="success-msg">
        ${type === "new" ? `<strong>${appName}</strong> has been created and linked.` : `<strong>${appName}</strong> has been linked to this project.`}
      </p>
      <div class="env-preview">NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...</div>
      <p class="success-msg">Keys written to <strong>.env</strong>. This tab will close in <span id="countdown">5</span>s...</p>
    </div>
  `;

  let seconds = 5;
  const countdown = document.getElementById("countdown")!;
  const interval = setInterval(() => {
    seconds--;
    countdown.textContent = String(seconds);
    if (seconds <= 0) {
      clearInterval(interval);
      window.close();
    }
  }, 1000);
}

// Start on sign-in screen
render("sign-in");
