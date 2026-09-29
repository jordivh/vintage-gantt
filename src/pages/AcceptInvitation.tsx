import { AuthShell } from "@/components/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { resolveRedirectAfterAuth } from "@/lib/auth-routes";
import {
  INVITATION_CANCEL,
  INVITATION_ERROR_MESSAGES,
  INVITATION_SAME_ADDRESS_HEADING,
  INVITATION_SESSION_HEADING,
  INVITATION_SIGN_OUT_AND_ACCEPT,
  invitationAnonymousSessionNotice,
  invitationErrorMessage,
  invitationHandledNotice,
  invitationSessionNotice,
  normalizeEmail,
} from "@/lib/company-users";
import { useMutation, useQuery } from "convex/react";
import { Loader2, LogOut, UserPlus } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";

/**
 * Accept an invitation.
 *
 * This page is the invitation's own destination, never the sign-in screen and
 * never a magic sign-in link. The order of business is fixed:
 *
 *   1. The token is checked first. An unknown, expired, revoked or already-used
 *      link shows one neutral sentence and offers nothing else — no form, no
 *      sign-in link, and no company or address.
 *   2. A live link asks for a name and a password, creates a brand-new regular
 *      account for the invited address in the inviting company, spends the link
 *      and signs that account in.
 *   3. If a session is already active, nothing is shown from behind it. The page
 *      says which account is signed in, which address the invitation is for, and
 *      offers "Sign out and accept invitation" or "Cancel". When the signed-in
 *      account already carries the invited address, the link is settled as
 *      handled and no duplicate account is ever created.
 */
export default function AcceptInvitation() {
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get("returnTo");
  const token = searchParams.get("token") ?? "";
  const destination = resolveRedirectAfterAuth(returnTo);

  const navigate = useNavigate();
  const { isLoading: sessionLoading, isAuthenticated, user, signIn, signOut } = useAuth();
  const preview = useQuery(api.companies.invitationPreview, token ? { token } : "skip");
  const acceptInvitation = useMutation(api.companies.acceptInvitation);
  const handleForCurrentAccount = useMutation(api.companies.handleInvitationForCurrentAccount);

  // `accepted` is set the moment the invitation is spent, and it outranks every
  // other branch: the preview query then reports the link as used, and that must
  // never be mistaken for a link that never worked.
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signInFailed, setSignInFailed] = useState(false);
  const [settleFailed, setSettleFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handled, setHandled] = useState<{ message: string; alreadyMember: boolean } | null>(null);
  const settledTokenRef = useRef<string | null>(null);

  const pending = preview?.state === "pending";
  const invitedEmail = pending ? preview.email : "";
  const signedInEmail = normalizeEmail(user?.email ?? "");
  const signedInAsInvitee =
    pending && isAuthenticated && Boolean(signedInEmail) && normalizeEmail(invitedEmail) === signedInEmail;

  // An invitation opened by the account it was sent to is already handled: the
  // link is settled, and no second account is ever created.
  useEffect(() => {
    if (!signedInAsInvitee || accepted || settledTokenRef.current === token) return;
    settledTokenRef.current = token;
    void handleForCurrentAccount({ token })
      .then((result) => {
        setHandled({
          message: invitationHandledNotice({
            email: result.email,
            companyName: pending ? preview.companyName : "",
            alreadyMember: result.alreadyMember,
          }),
          alreadyMember: result.alreadyMember,
        });
      })
      .catch(() => {
        console.error("Settling the invitation for the signed-in account failed.");
        setSettleFailed(true);
      });
  }, [signedInAsInvitee, accepted, token, handleForCurrentAccount, pending, preview?.companyName]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (!name) {
      setError(INVITATION_ERROR_MESSAGES.missing_name);
      return;
    }
    if (password.length < 8) {
      setError(INVITATION_ERROR_MESSAGES.weak_password);
      return;
    }

    setSubmitting(true);
    setError(null);
    let email = "";
    try {
      const result = await acceptInvitation({ token, name, password });
      email = result.email;
    } catch (cause) {
      // Never the error object: it can carry the invitation value or the password.
      console.error("Accepting the invitation failed.");
      setError(invitationErrorMessage(cause));
      setSubmitting(false);
      return;
    }

    // The account exists and the link is spent. Sign in as that new account.
    setAccepted(true);
    try {
      await signIn("password", { email, password, flow: "signIn" });
      navigate(destination, { replace: true });
    } catch {
      console.error("Signing in after accepting the invitation failed.");
      setSignInFailed(true);
    }
    setSubmitting(false);
  };

  /** Clears the existing session completely, then the form appears. */
  const signOutAndAccept = async () => {
    setSigningOut(true);
    setError(null);
    try {
      await signOut();
    } catch {
      console.error("Signing out before accepting the invitation failed.");
      setError(INVITATION_ERROR_MESSAGES.fallback);
    }
    setSigningOut(false);
  };

  /* --------------------------------- the invitation was just accepted here */

  if (accepted || submitting) {
    const settled = accepted && signInFailed;
    return (
      <AuthShell
        eyebrow="Invitation"
        title={settled ? "Your account is ready" : accepted ? "Welcome" : "Joining the company"}
        description={
          settled
            ? "The invitation was accepted and the account was created. Sign in with the address it was sent to."
            : accepted
              ? "Your account was created. Opening your company's environment…"
              : "Creating your account from this invitation…"
        }
        redirect={destination}
        allowAuthenticated
      >
        {settled ? (
          <div className="auth-notice-actions">
            <Button type="button" className="auth-submit" onClick={() => navigate("/auth")}>
              Go to sign in
            </Button>
          </div>
        ) : (
          <p className="auth-busy">
            <Loader2 className="h-4 w-4 animate-spin" /> Working…
          </p>
        )}
      </AuthShell>
    );
  }

  /* --------------------------------------------- the link names no invitation */

  if (!token) {
    return (
      <AuthShell
        eyebrow="Invitation"
        title="This invitation link cannot be used"
        description={INVITATION_ERROR_MESSAGES.invalid}
        redirect={destination}
        allowAuthenticated
      >
        {null}
      </AuthShell>
    );
  }

  /* --------------------------------------------------------- checking first */

  if (preview === undefined || sessionLoading) {
    return (
      <AuthShell
        eyebrow="Invitation"
        title="Accept invitation"
        description="Checking this invitation link…"
        redirect={destination}
        allowAuthenticated
      >
        <p className="auth-busy">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking the link…
        </p>
      </AuthShell>
    );
  }

  /* ---------------------------- unknown, expired, revoked or already used */

  if (preview.state !== "pending") {
    return (
      <AuthShell
        eyebrow="Invitation"
        title="This invitation link cannot be used"
        description={preview.message}
        redirect={destination}
        allowAuthenticated
      >
        {null}
      </AuthShell>
    );
  }

  /* --------------------------------- the invited account is already signed in */

  if (isAuthenticated && signedInAsInvitee && !handled) {
    return (
      <AuthShell
        eyebrow="Invitation"
        title={INVITATION_SAME_ADDRESS_HEADING}
        description={
          settleFailed
            ? INVITATION_ERROR_MESSAGES.fallback
            : "This invitation was sent to the account you are signed in with. Settling it now…"
        }
        redirect={destination}
        allowAuthenticated
      >
        {settleFailed ? null : (
          <p className="auth-busy">
            <Loader2 className="h-4 w-4 animate-spin" /> Settling the invitation…
          </p>
        )}
      </AuthShell>
    );
  }

  if (handled) {
    return (
      <AuthShell
        eyebrow="Invitation"
        title={INVITATION_SAME_ADDRESS_HEADING}
        description={handled.message}
        redirect={destination}
        allowAuthenticated
      >
        <div className="auth-notice-actions">
          <Button type="button" className="auth-submit" onClick={() => navigate(destination, { replace: true })}>
            {handled.alreadyMember ? "Open the company environment" : "Continue"}
          </Button>
        </div>
      </AuthShell>
    );
  }

  /* ------------------------------------------ another account is signed in */

  if (isAuthenticated) {
    // A different account, or a temporary session with no address at all. Either
    // way the page says so and waits: nothing happens without a choice, and the
    // existing session is never left showing behind this link.
    const notice = signedInEmail
      ? invitationSessionNotice({
          currentEmail: signedInEmail,
          currentName: user?.name ?? undefined,
          invitedEmail: preview.email,
          companyName: preview.companyName,
        })
      : invitationAnonymousSessionNotice(preview.companyName, preview.email);

    return (
      <AuthShell
        eyebrow="Invitation"
        title={INVITATION_SESSION_HEADING}
        description={notice}
        redirect={destination}
        allowAuthenticated
      >
        {error ? (
          <p className="auth-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="auth-notice-actions">
          <Button type="button" className="auth-submit" disabled={signingOut} onClick={signOutAndAccept}>
            {signingOut ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
            {INVITATION_SIGN_OUT_AND_ACCEPT}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="auth-submit"
            disabled={signingOut}
            onClick={() => navigate(destination, { replace: true })}
          >
            {INVITATION_CANCEL}
          </Button>
        </div>
      </AuthShell>
    );
  }

  /* ------------------------------------------------- the invited person's form */

  return (
    <AuthShell
      eyebrow="Invitation"
      title="Join your company"
      description={
        <>
          Set your name and a password to create the account this invitation is for
          {preview.companyName ? (
            <>
              {" "}
              at <strong>{preview.companyName}</strong>
            </>
          ) : null}
          .
        </>
      }
      redirect={destination}
      allowAuthenticated
    >
      <form className="auth-form" onSubmit={submit} noValidate>
        <label className="auth-field">
          <span>Email address</span>
          <Input value={preview.email} readOnly />
          <span className="auth-hint">This invitation creates an account for this address only.</span>
        </label>
        <label className="auth-field">
          <span>Your name</span>
          <Input name="name" type="text" autoComplete="name" placeholder="Marta Visser" disabled={submitting} required />
        </label>
        <label className="auth-field">
          <span>Password</span>
          <Input
            name="password"
            type="password"
            autoComplete="new-password"
            placeholder="At least 8 characters"
            disabled={submitting}
            required
          />
          <span className="auth-hint">At least 8 characters. Stored only as a hash by the auth service.</span>
        </label>

        {error ? (
          <p className="auth-error" role="alert">
            {error}
          </p>
        ) : null}

        <Button type="submit" className="auth-submit" disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Joining…
            </>
          ) : (
            <>
              <UserPlus className="h-4 w-4" /> Join the company
            </>
          )}
        </Button>
      </form>
    </AuthShell>
  );
}
