/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect } from 'react';
import { useAuth, useUser } from '@clerk/clerk-react';
import { getDefaultDesktopEntitlement, type DesktopEntitlement } from '@/lib/desktop-product';
import { resolveDesktopEntitlement } from '@/lib/desktop-entitlement';
import { useViewerStore } from '@/store';

/**
 * Sync Clerk auth + entitlement state into the viewer store.
 * Desktop plan state is authoritative here; chat inherits only the AI-specific permission.
 */
const ENTITLEMENT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

function entitlementsEqual(left: DesktopEntitlement, right: DesktopEntitlement): boolean {
  return left.tier === right.tier
    && left.status === right.status
    && left.source === right.source
    && left.userId === right.userId
    && left.validatedAt === right.validatedAt
    && left.graceUntil === right.graceUntil
    && left.trialEndsAt === right.trialEndsAt;
}

export function ClerkDesktopEntitlementSync() {
  const { isLoaded, isSignedIn, userId, getToken, has } = useAuth();
  const { user } = useUser();
  const setChatAuthToken = useViewerStore((s) => s.setChatAuthToken);
  const switchChatUserContext = useViewerStore((s) => s.switchChatUserContext);
  const setDesktopEntitlement = useViewerStore((s) => s.setDesktopEntitlement);

  useEffect(() => {
    if (!isLoaded) return;

    if (!isSignedIn) {
      const next = {
        ...getDefaultDesktopEntitlement(),
        status: 'signed_out' as const,
        source: 'cached' as const,
      };
      const state = useViewerStore.getState();
      if (!entitlementsEqual(state.desktopEntitlement, next)) {
        setDesktopEntitlement(next);
      }
      switchChatUserContext(null, false, {
        clearPersistedCurrent: state.chatStorageUserId !== null,
        restoreMessages: false,
      });
      setChatAuthToken(null);
      return;
    }

    let cancelled = false;

    const syncAuth = async () => {
      try {
        const token = await getToken({ skipCache: true });
        const { entitlement, aiAssistantEnabled } = resolveDesktopEntitlement({
          userId: userId ?? null,
          token,
          has,
          publicMetadata: (user?.publicMetadata ?? null) as Record<string, unknown> | null,
        });

        if (cancelled) {
          return;
        }

        const state = useViewerStore.getState();
        if (!entitlementsEqual(state.desktopEntitlement, entitlement)) {
          setDesktopEntitlement(entitlement);
        }
        if (state.chatStorageUserId !== (userId ?? null) || state.chatHasPro !== aiAssistantEnabled) {
          switchChatUserContext(userId ?? null, aiAssistantEnabled, {
            clearPersistedCurrent: state.chatStorageUserId !== null && state.chatStorageUserId !== userId,
            restoreMessages: true,
          });
        }
        setChatAuthToken(token ?? null);
      } catch {
        if (cancelled) {
          return;
        }

        const state = useViewerStore.getState();
        if (
          state.desktopEntitlement.tier === 'pro'
          && state.desktopEntitlement.graceUntil
          && state.desktopEntitlement.graceUntil > Date.now()
        ) {
          const next = {
            ...state.desktopEntitlement,
            status: 'grace_offline',
            source: 'cached',
          } satisfies DesktopEntitlement;
          if (!entitlementsEqual(state.desktopEntitlement, next)) {
            setDesktopEntitlement(next);
          }
          if (state.chatStorageUserId !== (userId ?? null) || state.chatHasPro !== true) {
            switchChatUserContext(userId ?? null, true, {
              clearPersistedCurrent: false,
              restoreMessages: true,
            });
          }
          return;
        }

        const next = {
          ...getDefaultDesktopEntitlement(),
          userId: userId ?? null,
          status: 'signed_out' as const,
          source: 'cached' as const,
        };
        if (!entitlementsEqual(state.desktopEntitlement, next)) {
          setDesktopEntitlement(next);
        }
      }
    };

    void syncAuth();
    const timer = window.setInterval(() => {
      void syncAuth();
    }, ENTITLEMENT_REFRESH_INTERVAL_MS);
    const onWindowFocus = () => {
      void syncAuth();
    };
    window.addEventListener('focus', onWindowFocus);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', onWindowFocus);
    };
  }, [
    getToken,
    has,
    isLoaded,
    isSignedIn,
    setChatAuthToken,
    setDesktopEntitlement,
    switchChatUserContext,
    user?.publicMetadata,
    userId,
  ]);

  return null;
}
