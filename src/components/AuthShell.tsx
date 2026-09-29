import { useAuth } from "@/hooks/use-auth";
import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router";

type AuthShellProps = {
  eyebrow: string;
  title: string;
  description: ReactNode;
  /** Where a visitor with a valid session is sent, e.g. the page they wanted. */
  redirect: string;
  /** Slightly wider card, for the registration form. */
  wide?: boolean;
  children: ReactNode;
  /** Optional secondary links under the form. */
  footer?: ReactNode;
};

/**
 * The one frame all four auth screens share: the paper card, the brand, the
 * heading, and the rule that a signed-in visitor is never left on a sign-in
 * form. Once a session exists — because they just signed in, registered or
 * reset their password, or because they arrived with one — this opens their
 * company environment instead.
 */
export function AuthShell({ eyebrow, title, description, redirect, wide, children, footer }: AuthShellProps) {
  const { isLoading, isAuthenticated } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoading && isAuthenticated) navigate(redirect, { replace: true });
  }, [isLoading, isAuthenticated, navigate, redirect]);

  return (
    <main className="auth-screen">
      <section className={`auth-card${wide ? " auth-card-wide" : ""}`}>
        <button
          type="button"
          className="auth-brand"
          onClick={() => navigate("/")}
          title="Back to the start page"
        >
          <span className="auth-seal">⌁</span>
          <span>Vintage GANTT</span>
        </button>

        <div className="auth-eyebrow">{eyebrow}</div>
        <h1 className="auth-title">{title}</h1>
        <p className="auth-sub">{description}</p>

        {children}

        {footer ? <div className="auth-alt">{footer}</div> : null}
      </section>

      <p className="auth-foot">
        Secured by{" "}
        <a href="https://freebuff.com" target="_blank" rel="noopener noreferrer">
          freebuff.com
        </a>
      </p>
    </main>
  );
}

export default AuthShell;
