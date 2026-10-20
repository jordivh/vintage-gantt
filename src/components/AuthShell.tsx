import { useAuth } from "@/hooks/use-auth";
import { CHANGE_PASSWORD_PATH } from "@/lib/navigation";
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
  /**
   * Keep the screen visible for a visitor who already has a session.
   *
   * Off for every sign-in surface, where a session means the visitor is done and
   * belongs in their environment. On for a screen that is its own instruction and
   * must be shown to a signed-in visitor rather than skipped.
   */
  allowAuthenticated?: boolean;
};

/**
 * The one frame all four auth screens share: the paper card, the brand, the
 * heading, and the rule that a signed-in visitor is never left on a sign-in
 * form. Once a session exists — because they just signed in, registered or
 * reset their password, or because they arrived with one — this opens their
 * company environment instead.
 */
export function AuthShell({ eyebrow, title, description, redirect, wide, children, footer, allowAuthenticated }: AuthShellProps) {
  const { isLoading, isAuthenticated, user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (allowAuthenticated) return;
    if (!isLoading && isAuthenticated) {
      navigate(user?.mustChangePassword ? CHANGE_PASSWORD_PATH : redirect, { replace: true });
    }
  }, [allowAuthenticated, isLoading, isAuthenticated, navigate, redirect, user?.mustChangePassword]);

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
