/**
 * Shared messaging constants used across surfaces. This module collects
 * duplicated strings for eventual centralization. New cross-surface messages
 * go here.
 */

export const BACKGROUND_HANDOFF = "Initialization continues in the background";

export const cdHint = (path: string): string => `Run: cd ${path}`;
