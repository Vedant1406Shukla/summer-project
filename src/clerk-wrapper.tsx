import React from 'react';
import { useAuth, ClerkProvider as OriginalClerkProvider } from '@clerk/react-original';

// Re-export everything from @clerk/react package
export * from '@clerk/react-original';

interface ClerkProviderProps {
  children: React.ReactNode;
  afterSignOutUrl?: string;
  [key: string]: any;
}

export function ClerkProvider({ children, ...props }: ClerkProviderProps) {
  const publishableKey = (import.meta as any).env.VITE_CLERK_PUBLISHABLE_KEY;
  return (
    <OriginalClerkProvider publishableKey={publishableKey} {...props}>
      {children}
    </OriginalClerkProvider>
  );
}

interface ShowProps {
  when: 'signed-in' | 'signed-out';
  children: React.ReactNode;
}

export function Show({ when, children }: ShowProps) {
  const { isSignedIn, isLoaded } = useAuth();

  if (!isLoaded) return null;

  if (when === 'signed-in' && isSignedIn) {
    return <>{children}</>;
  }

  if (when === 'signed-out' && !isSignedIn) {
    return <>{children}</>;
  }

  return null;
}
