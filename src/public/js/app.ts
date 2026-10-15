/**
 * Small vanilla helpers (frontend doc §1: one JS file, vanilla):
 * - session-loss handling: a 401 from any app fetch is the moment of loss
 *   (the app itself never deletes sessions except logout/expiry) → show a
 *   banner with the reason (missing | unknown | expired, from /api/me and
 *   the middleware 401s) and redirect to /login?next=<page>.
 * - AI-working badge poll (frontend doc §2, every 5s).
 */
interface Window {
  novelApi: (path: string, opts?: RequestInit) => Promise<unknown>;
  novelOn401: (reason?: string) => void;
  novelAuthLost: () => boolean;
}
(function () {
  "use strict";

  // ---------- session loss ----------
  var authLost = false;
  /** read the diagnostic reason from a 401 body (clones, caller keeps res) */
  async function reasonOf401(res: Response): Promise<string | undefined> {
    try {
      return ((await res.clone().json()) as { reason?: string }).reason;
    } catch {
      return undefined;
    }
  }
  function on401(reason: string | undefined) {
    if (authLost) return;
    authLost = true;
    const n = document.getElementById("auth-lost");
    if (n) {
      n.hidden = false;
      const detail =
        reason === "expired"
          ? " (session expired)"
          : reason === "missing"
            ? " (cookie not sent)"
            : reason === "unknown"
              ? " (unknown session)"
              : "";
      n.textContent = `You have been logged out${detail} — returning to the login page…`;
    }
    window.setTimeout(() => {
      window.location.href =
        "/login?next=" + encodeURIComponent(window.location.pathname + window.location.search);
    }, 1500);
  }

  /** fetch wrapper: JSON in/out; routes 401 to the banner. */
  async function api(path: string, opts?: RequestInit): Promise<unknown> {
    const res = await fetch(path, opts);
    if (res.status === 401) {
      on401(await reasonOf401(res));
      throw new Error("not authenticated");
    }
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error((j as { error?: string }).error ?? "request failed");
    }
    return res.json();
  }
  // Global: any 401 from any view's fetch (badge, monitor, actions) is a
  // session loss — show the banner once. Same-origin relative URLs only.
  const origFetch = window.fetch.bind(window);
  (window as unknown as { fetch: (input: RequestInfo | URL, init: RequestInit) => Promise<Response> }).fetch =
    function (input: RequestInfo | URL, init: RequestInit) {
      return origFetch(input, init).then((res) => {
        if (
          res.status === 401 &&
          typeof input === "string" &&
          input.startsWith("/") &&
          !input.startsWith("/login")
        ) {
          void reasonOf401(res).then(on401);
        }
        return res;
      });
    };
  // views keep their own helpers; expose these so future pages can use them
  window.novelApi = api;
  window.novelOn401 = on401;
  window.novelAuthLost = () => authLost;

  // ---------- AI badge (frontend doc §2) ----------
  const badgeEl = document.getElementById("ai-badge");
  const labelEl = document.getElementById("ai-badge-label");
  if (!badgeEl || !labelEl) return;
  const badge = badgeEl;
  const badgeLabel = labelEl;

  const KIND_LABELS: Record<string, string> = {
    generate: "writing a chapter…",
    summarize: "summarizing…",
    lore_suggest: "suggesting lore…",
    image_desc: "describing image…",
    style_extract: "extracting style…",
  };

  async function poll() {
    if (authLost) return;
    try {
      const res = await fetch("/api/ai/current", { credentials: "same-origin" });
      if (res.status === 401) {
        badge.hidden = true;
        on401(await reasonOf401(res));
        return;
      }
      if (!res.ok) {
        badge.hidden = true; // server hiccup; retry on next tick
        return;
      }
      const data = (await res.json()) as {
        run?: { kind: string; title?: string };
      };
      if (data && data.run) {
        const label = KIND_LABELS[data.run.kind] ?? "AI working…";
        // name the story when known, so any page makes clear WHICH story is
        // locked while the AI works on it
        badgeLabel.textContent = data.run.title
          ? `${label} “${data.run.title}”`
          : label;
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }
    } catch {
      badge.hidden = true; // network down; retry on next tick
    }
  }

  poll();
  window.setInterval(poll, 5000);
})();
