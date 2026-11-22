import { useEffect, useRef, useState } from "react";

const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
let pendingScript;

function googleIdentity() {
  if (window.google?.accounts?.id)
    return Promise.resolve(window.google.accounts.id);
  pendingScript ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    function fail() {
      clearTimeout(timer);
      script.remove();
      pendingScript = undefined;
      reject(new Error("Google sign-in could not load."));
    }
    const timer = setTimeout(fail, 12_000);
    script.onload = () => {
      clearTimeout(timer);
      if (window.google?.accounts?.id) resolve(window.google.accounts.id);
      else fail();
    };
    script.onerror = fail;
    document.head.append(script);
  });
  return pendingScript;
}

export function GoogleButton({ onCredential, disabled }) {
  const element = useRef(null);
  const [state, setState] = useState("loading");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!clientId) return;
    let mounted = true;
    googleIdentity()
      .then((google) => {
        if (!mounted) return;
        element.current.replaceChildren();
        google.initialize({
          client_id: clientId,
          ux_mode: "popup",
          use_fedcm_for_button: true,
          callback: ({ credential }) => {
            if (mounted) onCredential(credential);
          },
        });
        google.renderButton(element.current, {
          theme: "outline",
          size: "large",
          shape: "rectangular",
          width: 240,
        });
        setState("ready");
      })
      .catch(() => {
        if (mounted) setState("error");
      });
    return () => {
      mounted = false;
    };
  }, [onCredential, retry]);

  if (!clientId)
    return (
      <p className="support">
        Google sign-in is unavailable in this environment.
      </p>
    );
  return (
    <>
      <div ref={element} hidden={state !== "ready" || disabled} />
      {state === "loading" && (
        <p className="support">Loading Google sign-in…</p>
      )}
      {state === "error" && (
        <div className="notice notice-error" role="alert">
          <p>Google sign-in could not load.</p>
          <button
            type="button"
            className="secondary-action"
            disabled={disabled}
            onClick={() => {
              setState("loading");
              setRetry(retry + 1);
            }}
          >
            Retry Google
          </button>
        </div>
      )}
    </>
  );
}
