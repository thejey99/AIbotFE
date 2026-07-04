import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut as fbSignOut,
  onAuthStateChanged,
  type User,
} from "firebase/auth";

// All values come from Render environment variables (baked in at build time).
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FB_API_KEY,
  authDomain: import.meta.env.VITE_FB_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FB_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FB_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FB_SENDER_ID,
  appId: import.meta.env.VITE_FB_APP_ID,
};

if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
  throw new Error(
    "Firebase config missing. Set VITE_FB_* environment variables in Render and redeploy."
  );
}

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Complete a redirect-based sign-in if we're returning from one.
// Harmless no-op otherwise. Errors surface via the sign-in button flow.
getRedirectResult(auth).catch(() => {});

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

export async function signIn(): Promise<void> {
  try {
    await signInWithPopup(auth, provider);
  } catch (err: any) {
    // Popup blocked or unsupported (common in installed PWAs / some mobile
    // browsers) -> fall back to full-page redirect. With authDomain on our
    // own origin, redirect state survives storage partitioning.
    const code: string = err?.code ?? "";
    if (
      code === "auth/popup-blocked" ||
      code === "auth/popup-closed-by-user" ||
      code === "auth/cancelled-popup-request" ||
      code === "auth/operation-not-supported-in-this-environment"
    ) {
      await signInWithRedirect(auth, provider);
      return;
    }
    throw err;
  }
}

export function signOut(): Promise<void> {
  return fbSignOut(auth);
}

export function watchAuth(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, callback);
}

export async function getToken(): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");
  return user.getIdToken(); // SDK auto-refreshes; cached until near expiry
}
