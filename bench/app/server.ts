// A small app with deliberately planted bugs, used to benchmark bug reproduction.
// Usage: bun bench/app/server.ts [port]   (default 4173)

const PORT = Number(process.argv[2] ?? 4173);
const FIXED = process.env.FIXED === "1"; // control run: every planted bug fixed

const page = (title: string, body: string, script = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} · Acme</title>
<style>
  body { font: 15px system-ui, sans-serif; max-width: 760px; margin: 24px auto; padding: 0 16px; }
  nav a { margin-right: 12px; } .row { display: flex; gap: 12px; align-items: center; margin: 6px 0; }
  .error { color: #b00020; } .ok { color: #08660b; } button { cursor: pointer; }
  [hidden] { display: none !important; } li.done span { text-decoration: line-through; }
</style></head>
<body><nav><a href="/">Home</a><a href="/shop">Shop</a><a href="/signup">Sign up</a><a href="/todos">Todos</a><a href="/settings">Settings</a><a href="/search">Search</a></nav>
<h1>${title}</h1>${body}<script>${script}</script></body></html>`;

const PRODUCTS = [
  { id: "mug", name: "Blue Mug", price: 12 },
  { id: "kettle", name: "Red Kettle", price: 35 },
  { id: "towel", name: "Tea Towel", price: 8 },
  { id: "teapot", name: "Glass Teapot", price: 29 },
];

const ARTICLES = Array.from({ length: 23 }, (_, i) => `Brewing guide #${i + 1}: ${["green", "black", "oolong", "white"][i % 4]} tea`);

// In-memory server state for the settings bug.
let settings = { emailNotifications: true, smsNotifications: false, digest: "weekly" };

const routes: Record<string, (req: Request, url: URL) => Response | Promise<Response>> = {
  "/": () => html(page("Acme Home", `<p>Welcome to Acme. Pick a section above.</p>`)),

  // Bug 1: removing an item from the cart doesn't update the total.
  "/shop": () =>
    html(
      page(
        "Shop",
        `<section aria-label="Products">${PRODUCTS.map(
          (p) => `<div class="row"><span>${p.name}</span><span>$${p.price}.00</span><button data-id="${p.id}" aria-label="Add ${p.name} to cart">Add to cart</button></div>`,
        ).join("")}</section>
        <p><button id="open-cart">Cart (<span id="count">0</span>)</button></p>
        <section id="cart" aria-label="Cart" hidden><h2>Your cart</h2><ul id="lines"></ul>
        <p>Total: <strong id="total">$0.00</strong></p><button id="close-cart">Continue shopping</button></section>`,
        `const products = ${JSON.stringify(PRODUCTS)}; const cart = []; let total = 0;
        const fmt = (n) => "$" + n.toFixed(2);
        function render() {
          document.getElementById("count").textContent = cart.length;
          document.getElementById("lines").innerHTML = cart.map((p, i) =>
            '<li class="row"><span>' + p.name + '</span><span>' + fmt(p.price) + '</span><button data-i="' + i + '" aria-label="Remove ' + p.name + '">Remove</button></li>').join("");
          document.getElementById("total").textContent = fmt(total);
        }
        document.querySelectorAll("[data-id]").forEach((b) => b.onclick = () => {
          const p = products.find((x) => x.id === b.dataset.id); cart.push(p); total += p.price; render();
        });
        document.getElementById("lines").onclick = (e) => {
          const i = e.target.dataset.i; if (i === undefined) return;
          ${FIXED ? "total -= cart[Number(i)].price;" : ""} cart.splice(Number(i), 1); render(); // BUG: total is never reduced
        };
        document.getElementById("open-cart").onclick = () => document.getElementById("cart").hidden = false;
        document.getElementById("close-cart").onclick = () => document.getElementById("cart").hidden = true;
        render();`,
      ),
    ),

  // Bug 2: plus-addressed emails are rejected.
  "/signup": () =>
    html(
      page(
        "Create your account",
        `<form id="f" novalidate>
          <div class="row"><label for="name">Full name</label><input id="name" name="name"></div>
          <div class="row"><label for="email">Email</label><input id="email" name="email" type="email"></div>
          <div class="row"><label for="pw">Password</label><input id="pw" name="pw" type="password"></div>
          <div class="row"><label for="country">Country</label><select id="country" name="country"><option value="">Choose…</option><option>India</option><option>United States</option><option>Germany</option></select></div>
          <div class="row"><input id="terms" type="checkbox"><label for="terms">I agree to the terms</label></div>
          <button type="submit">Create account</button>
        </form><p id="msg" role="status"></p>`,
        `document.getElementById("f").onsubmit = (e) => {
          e.preventDefault(); const v = (id) => document.getElementById(id).value.trim(); const msg = document.getElementById("msg");
          const errors = [];
          if (!v("name")) errors.push("Name is required");
          if (!/^[a-z0-9._${FIXED ? "+" : ""}-]+@[a-z0-9.-]+\\.[a-z]{2,}$/i.test(v("email"))) errors.push("Please enter a valid email address"); // BUG: no "+"
          if (v("pw").length < 8) errors.push("Password must be at least 8 characters");
          if (!v("country")) errors.push("Choose a country");
          if (!document.getElementById("terms").checked) errors.push("You must accept the terms");
          msg.className = errors.length ? "error" : "ok";
          msg.textContent = errors.length ? errors.join(". ") + "." : "Welcome aboard, " + v("name") + "! Check your inbox to confirm.";
        };`,
      ),
    ),

  // Bug 3: completed todos still appear under the "Active" filter.
  "/todos": () =>
    html(
      page(
        "Todos",
        `<div class="row"><label for="new">New todo</label><input id="new" placeholder="What needs doing?"><button id="add">Add</button></div>
        <ul id="list" aria-label="Todo list"></ul>
        <div class="row" role="group" aria-label="Filter"><button data-f="all">All</button><button data-f="active">Active</button><button data-f="done">Completed</button></div>
        <p id="left"></p>`,
        `const todos = []; let filter = "all";
        function render() {
          const shown = todos.filter((t) => filter === "all" ? true : filter === "active" ? ${FIXED ? "!t.done" : "true"} /* BUG: should be !t.done */ : t.done);
          document.getElementById("list").innerHTML = shown.map((t) =>
            '<li class="' + (t.done ? "done" : "") + '"><input type="checkbox" id="t' + t.id + '" ' + (t.done ? "checked" : "") + ' data-id="' + t.id + '"><label for="t' + t.id + '"><span>' + t.text + '</span></label></li>').join("");
          document.getElementById("left").textContent = todos.filter((t) => !t.done).length + " items left · showing " + filter;
        }
        const add = () => { const i = document.getElementById("new"); if (!i.value.trim()) return; todos.push({ id: todos.length + 1, text: i.value.trim(), done: false }); i.value = ""; render(); };
        document.getElementById("add").onclick = add;
        document.getElementById("new").onkeydown = (e) => { if (e.key === "Enter") add(); };
        document.getElementById("list").onchange = (e) => { const t = todos.find((x) => x.id == e.target.dataset.id); t.done = e.target.checked; render(); };
        document.querySelectorAll("[data-f]").forEach((b) => b.onclick = () => { filter = b.dataset.f; render(); });
        render();`,
      ),
    ),

  // Bug 4: turning off email notifications doesn't persist after reload.
  "/settings": () =>
    html(
      page(
        "Settings",
        `<div role="tablist"><button role="tab" id="tab-profile" aria-selected="true">Profile</button><button role="tab" id="tab-notif" aria-selected="false">Notifications</button></div>
        <section id="p-profile" aria-label="Profile"><div class="row"><label for="display">Display name</label><input id="display" value="Sam"></div></section>
        <section id="p-notif" aria-label="Notifications" hidden>
          <div class="row"><input type="checkbox" role="switch" id="email-n" ${settings.emailNotifications ? "checked" : ""}><label for="email-n">Email notifications</label></div>
          <div class="row"><input type="checkbox" role="switch" id="sms-n" ${settings.smsNotifications ? "checked" : ""}><label for="sms-n">SMS notifications</label></div>
          <div class="row"><label for="digest">Digest</label><select id="digest"><option ${settings.digest === "daily" ? "selected" : ""}>daily</option><option ${settings.digest === "weekly" ? "selected" : ""}>weekly</option></select></div>
        </section>
        <button id="save">Save changes</button><p id="saved" role="status"></p>`,
        `const tabs = { "tab-profile": "p-profile", "tab-notif": "p-notif" };
        for (const [t, p] of Object.entries(tabs)) document.getElementById(t).onclick = () => {
          for (const [t2, p2] of Object.entries(tabs)) { document.getElementById(p2).hidden = t2 !== t; document.getElementById(t2).setAttribute("aria-selected", t2 === t); }
        };
        document.getElementById("save").onclick = async () => {
          await fetch("/api/settings", { method: "POST", body: JSON.stringify({
            emailNotifications: document.getElementById("email-n").checked,
            smsNotifications: document.getElementById("sms-n").checked,
            digest: document.getElementById("digest").value }) });
          document.getElementById("saved").textContent = "Settings saved.";
        };`,
      ),
    ),

  "/api/settings": async (req) => {
    if (req.method === "POST") {
      const next = (await req.json()) as Partial<typeof settings>;
      settings = { ...settings, ...next, ...(FIXED ? {} : { emailNotifications: settings.emailNotifications }) }; // BUG: email flag dropped
    }
    return Response.json(settings);
  },

  // Bug 5: page 2 of search results repeats page 1.
  "/search": (_req, url) => {
    const q = url.searchParams.get("q") ?? "";
    const pageNo = Math.max(1, Number(url.searchParams.get("page") ?? 1));
    const hits = q ? ARTICLES.filter((a) => a.toLowerCase().includes(q.toLowerCase()) || q.toLowerCase() === "tea") : [];
    const start = FIXED ? (pageNo - 1) * 5 : 0; // BUG: should be (pageNo - 1) * 5
    const shown = hits.slice(start, start + 5);
    const pages = Math.ceil(hits.length / 5);
    return html(
      page(
        "Search",
        `<form action="/search" role="search"><label for="q">Search articles</label> <input id="q" name="q" value="${q.replace(/"/g, "&quot;")}"> <button>Search</button></form>
        ${q ? `<p>${hits.length} results for “${q}” · page ${pageNo} of ${pages || 1}</p><ol start="${(pageNo - 1) * 5 + 1}">${shown.map((h) => `<li>${h}</li>`).join("")}</ol>
        <nav aria-label="Pagination">${Array.from({ length: pages }, (_, i) => `<a href="/search?q=${encodeURIComponent(q)}&page=${i + 1}" ${i + 1 === pageNo ? 'aria-current="page"' : ""}>Page ${i + 1}</a>`).join(" ")}</nav>` : ""}`,
      ),
    );
  },

  "/__reset": () => {
    settings = { emailNotifications: true, smsNotifications: false, digest: "weekly" };
    return new Response("ok");
  },
};

function html(body: string) {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    const route = routes[url.pathname];
    return route ? route(req, url) : new Response("Not found", { status: 404 });
  },
});
console.log(`bug app on http://localhost:${PORT}${FIXED ? " (bugs fixed)" : ""}`);
