/**
 * Confirmation Flow Response Builders Tests
 */

import { describe, it, expect } from 'vitest';
import {
  buildSafeModeBlockedResponse,
  buildInvalidParameterResponse,
  buildConflictingParametersResponse,
  buildConfirmationRequiredResponse,
  buildPreviewRequiredResponse,
  buildPreviewExpiredResponse,
  type ConfirmationContext,
} from './confirmation-responses.js';

const ctx: ConfirmationContext = {
  tool: 'delete_site_v1',
  ability: 'mainwp/delete-site-v1',
};

describe('buildSafeModeBlockedResponse', () => {
  it('should include error code and message', () => {
    const response = buildSafeModeBlockedResponse(ctx) as Record<string, unknown>;

    expect(response.error).toBe('SAFE_MODE_BLOCKED');
    expect(response.message).toContain('Safe mode blocked');
    expect(response.message).toContain('delete_site_v1');
  });

  it('should include tool and ability context', () => {
    const response = buildSafeModeBlockedResponse(ctx) as { details: Record<string, unknown> };

    expect(response.details.tool).toBe('delete_site_v1');
    expect(response.details.ability).toBe('mainwp/delete-site-v1');
  });

  it('should provide resolution guidance', () => {
    const response = buildSafeModeBlockedResponse(ctx) as { details: Record<string, unknown> };

    expect(response.details.reason).toContain('safe mode');
    expect(response.details.resolution).toContain('MAINWP_SAFE_MODE');
  });
});

describe('buildInvalidParameterResponse', () => {
  it('should indicate invalid parameter error', () => {
    const response = buildInvalidParameterResponse(ctx) as Record<string, unknown>;

    expect(response.error).toBe('INVALID_PARAMETER');
    expect(response.message).toContain('user_confirmed');
  });

  it('should include context details', () => {
    const response = buildInvalidParameterResponse(ctx) as { details: Record<string, unknown> };

    expect(response.details.tool).toBe('delete_site_v1');
    expect(response.details.ability).toBe('mainwp/delete-site-v1');
  });

  it('should explain the resolution', () => {
    const response = buildInvalidParameterResponse(ctx) as { details: Record<string, unknown> };

    expect(response.details.resolution).toContain('Remove');
    expect(response.details.resolution).toContain('user_confirmed');
  });
});

describe('buildConflictingParametersResponse', () => {
  it('should indicate conflicting parameters error', () => {
    const response = buildConflictingParametersResponse(ctx) as Record<string, unknown>;

    expect(response.error).toBe('CONFLICTING_PARAMETERS');
    expect(response.message).toContain('user_confirmed');
    expect(response.message).toContain('dry_run');
  });

  it('should explain the conflict', () => {
    const response = buildConflictingParametersResponse(ctx) as {
      details: Record<string, unknown>;
    };

    expect(response.details.reason).toContain('dry_run');
    expect(response.details.reason).toContain('user_confirmed');
  });
});

describe('buildConfirmationRequiredResponse', () => {
  const preview = { affected_sites: [1, 2, 3], total: 3 };

  it('should include status and preview data', () => {
    const response = buildConfirmationRequiredResponse(ctx, preview) as Record<string, unknown>;

    expect(response.status).toBe('CONFIRMATION_REQUIRED');
    expect(response.preview).toEqual(preview);
  });

  it('should include instructions for confirmation', () => {
    const response = buildConfirmationRequiredResponse(ctx, preview) as Record<string, unknown>;

    expect(response.instructions).toContain('user_confirmed');
    expect(response.instructions).toContain('true');
  });

  it('should include metadata with expiry', () => {
    const response = buildConfirmationRequiredResponse(ctx, preview) as {
      metadata: Record<string, unknown>;
    };

    expect(response.metadata.tool).toBe('delete_site_v1');
    expect(response.metadata.ability).toBe('mainwp/delete-site-v1');
    expect(response.metadata.expiresIn).toContain('5 minutes');
  });
});

describe('buildPreviewRequiredResponse', () => {
  it('should indicate preview required error', () => {
    const response = buildPreviewRequiredResponse(ctx) as Record<string, unknown>;

    expect(response.error).toBe('PREVIEW_REQUIRED');
    expect(response.message).toContain('No preview found');
  });

  it('should explain how to generate preview', () => {
    const response = buildPreviewRequiredResponse(ctx) as { details: Record<string, unknown> };

    expect(response.details.resolution).toContain('confirm: true');
  });
});

describe('buildPreviewExpiredResponse', () => {
  it('should indicate preview expired error', () => {
    const response = buildPreviewExpiredResponse(ctx) as Record<string, unknown>;

    expect(response.error).toBe('PREVIEW_EXPIRED');
    expect(response.message).toContain('expired');
  });

  it('should include expiry reason', () => {
    const response = buildPreviewExpiredResponse(ctx) as { details: Record<string, unknown> };

    expect(response.details.reason).toContain('5 minutes');
  });

  it('should explain how to generate new preview', () => {
    const response = buildPreviewExpiredResponse(ctx) as { details: Record<string, unknown> };

    expect(response.details.resolution).toContain('confirm: true');
  });
});
