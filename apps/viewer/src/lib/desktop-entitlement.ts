/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  getDefaultDesktopEntitlement,
  hasDesktopFeatureAccess,
  type DesktopEntitlement,
  type DesktopFeature,
} from './desktop-product';

const DEFAULT_OFFLINE_GRACE_DAYS = 7;

type HasFn = ((params: { plan?: string; feature?: string }) => boolean) | undefined;

interface ResolveDesktopEntitlementOptions {
  userId: string | null;
  token: string | null;
  has: HasFn;
  publicMetadata: Record<string, unknown> | null | undefined;
  now?: number;
}

interface ResolvedDesktopEntitlement {
  entitlement: DesktopEntitlement;
  aiAssistantEnabled: boolean;
}

function decodeJwtPayload(token: string | null): Record<string, unknown> | null {
  if (!token) {
    return null;
  }
  try {
    const [, payload] = token.split('.');
    if (!payload) {
      return null;
    }
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = globalThis.atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readValue(payload: Record<string, unknown> | null, metadata: Record<string, unknown> | null | undefined, key: string): unknown {
  if (payload && key in payload) {
    return payload[key];
  }
  if (metadata && key in metadata) {
    return metadata[key];
  }
  return undefined;
}

function toTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return asNumber > 10_000_000_000 ? asNumber : asNumber * 1000;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function hasAnyFeature(features: string[], required: string[]): boolean {
  return required.some((feature) => features.includes(feature));
}

function resolveTier(payload: Record<string, unknown> | null, has: HasFn, metadata: Record<string, unknown> | null | undefined): 'free' | 'pro' {
  const directPlan = readValue(payload, metadata, 'desktop_plan');
  if (directPlan === 'pro' || directPlan === 'free') {
    return directPlan;
  }

  const featureList = toStringArray(readValue(payload, metadata, 'desktop_features'));
  if (hasAnyFeature(featureList, ['desktop_pro', 'desktop_exports', 'desktop_ids', 'desktop_bcf', 'desktop_ai'])) {
    return 'pro';
  }

  if (has?.({ feature: 'desktop_pro' }) || has?.({ plan: 'desktop-pro' }) || has?.({ plan: 'pro' }) || has?.({ feature: 'pro_models' })) {
    return 'pro';
  }

  return 'free';
}

export function resolveDesktopEntitlement(options: ResolveDesktopEntitlementOptions): ResolvedDesktopEntitlement {
  const { userId, token, has, publicMetadata, now = Date.now() } = options;
  const payload = decodeJwtPayload(token);
  const fallback = getDefaultDesktopEntitlement();
  const tier = resolveTier(payload, has, publicMetadata);
  const trialEndsAt = toTimestampMs(readValue(payload, publicMetadata, 'desktop_trial_ends_at'));
  const graceDays = Number(readValue(payload, publicMetadata, 'desktop_grace_days') ?? DEFAULT_OFFLINE_GRACE_DAYS);
  const explicitGraceUntil = toTimestampMs(readValue(payload, publicMetadata, 'desktop_grace_until'));
  const graceUntil = explicitGraceUntil ?? (tier === 'pro' ? now + Math.max(0, graceDays) * 24 * 60 * 60 * 1000 : null);
  const explicitStatus = readValue(payload, publicMetadata, 'desktop_status');

  let status: DesktopEntitlement['status'];
  if (
    explicitStatus === 'anonymous'
    || explicitStatus === 'signed_out'
    || explicitStatus === 'active'
    || explicitStatus === 'trial'
    || explicitStatus === 'expired'
    || explicitStatus === 'grace_offline'
  ) {
    status = explicitStatus;
  } else if (trialEndsAt && trialEndsAt > now) {
    status = 'trial';
  } else if (tier === 'pro') {
    status = 'active';
  } else if (trialEndsAt && trialEndsAt <= now) {
    status = 'expired';
  } else {
    status = fallback.status;
  }

  const entitlement: DesktopEntitlement = {
    tier,
    status,
    source: 'clerk_claims',
    userId,
    validatedAt: now,
    graceUntil,
    trialEndsAt,
  };

  const aiAssistantEnabled = hasDesktopFeatureAccess(entitlement, 'ai_assistant');
  return { entitlement, aiAssistantEnabled };
}

export function canUseDesktopFeatureOffline(entitlement: DesktopEntitlement, feature: DesktopFeature, now = Date.now()): boolean {
  if (hasDesktopFeatureAccess(entitlement, feature)) {
    return true;
  }
  return entitlement.status === 'grace_offline' && !!entitlement.graceUntil && entitlement.graceUntil > now;
}
