import { useAuth } from "@/hooks/use-auth";
import { Loader2 } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useAuth();
  const location = useLocation();

  useEffect(() => {
    // A page restored from the browser's back/forward cache keeps its old DOM
    // snapshot. Force a real load on restore, so the session is checked again
    // and a page can never show protected data from a stale snapshot after a
    // sign-out.
    const revalidate = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", revalidate);
    return () => window.removeEventListener("pageshow", revalidate);
  }, []);

  if (isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (!isAuthenticated) {
    const returnTo = `${location.pathname}${location.search}`;
    return (
      <Navigate
        to={`/auth?returnTo=${encodeURIComponent(returnTo)}`}
        replace
      />
    );
  }

  return children;
}
