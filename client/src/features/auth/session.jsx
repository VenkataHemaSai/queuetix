import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.js";

const Session = createContext(null);
const key = "queuetix.session";
const expired = "Your session expired. Sign in again.";

function storedSession() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(key));
    if (
      typeof stored?.token === "string" &&
      Number.isFinite(Date.parse(stored.expiresAt))
    ) {
      return { token: stored.token, expiresAt: stored.expiresAt };
    }
  } catch {
    return null;
  }
  return null;
}

function store(session) {
  try {
    if (session) sessionStorage.setItem(key, JSON.stringify(session));
    else sessionStorage.removeItem(key);
  } catch {
    // The current page can still use the session when browser storage is unavailable.
  }
}

export function SessionProvider({ children }) {
  const cache = useQueryClient();
  const [session, setSession] = useState(storedSession);
  const liveToken = useRef(session?.token);
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState(() =>
    session ? "loading" : "signed-out",
  );
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);

  const clear = useCallback(
    (message = "") => {
      liveToken.current = undefined;
      store(null);
      setSession(null);
      setUser(null);
      setStatus("signed-out");
      setError(null);
      setNotice(message);
      cache.removeQueries({ queryKey: ["organizer"] });
    },
    [cache],
  );

  const signIn = useCallback(({ token, expiresAt, user }) => {
    const credentials = { token, expiresAt };
    liveToken.current = token;
    store(credentials);
    setSession(credentials);
    setUser(user);
    setStatus("signed-in");
    setNotice("");
    setError(null);
  }, []);

  useEffect(() => {
    if (!session) return;
    const remaining = Date.parse(session.expiresAt) - Date.now();
    if (remaining <= 0) {
      clear(expired);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => clear(expired), remaining);
    api("/me", { token: session.token, signal: controller.signal })
      .then(({ user }) => {
        if (controller.signal.aborted) return;
        setUser(user);
        setStatus("signed-in");
        setError(null);
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        if (failure.status === 401) {
          clear(failure.code === "SESSION_EXPIRED" ? expired : failure.message);
        } else {
          setError(failure);
          setStatus("error");
        }
      });
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [session, clear, attempt]);

  const request = useCallback(
    async (path, options) => {
      try {
        return await api(path, { ...options, token: session?.token });
      } catch (failure) {
        if (failure.status === 401 && liveToken.current === session?.token) {
          clear(failure.code === "SESSION_EXPIRED" ? expired : failure.message);
        }
        throw failure;
      }
    },
    [session, clear],
  );

  function retry() {
    setStatus("loading");
    setAttempt((value) => value + 1);
  }

  return (
    <Session.Provider
      value={{
        user,
        status,
        error,
        notice,
        signIn,
        signOut: clear,
        request,
        retry,
      }}
    >
      {children}
    </Session.Provider>
  );
}

export function useSession() {
  return useContext(Session);
}
