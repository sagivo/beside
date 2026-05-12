export type Screen =
  | 'dashboard'
  | 'meetings'
  | 'privacy'
  | 'search'
  | 'connect'
  | 'settings'
  | 'help';

export const ONBOARDING_KEY = 'beside:onboarded';
/**
 * Mid-onboarding progress marker — lets us restore the user to the
 * step they were on if the app relaunches (e.g. after granting
 * Screen Recording, which only takes effect on the next process
 * lifetime).
 */
export const ONBOARDING_STEP_KEY = 'beside:onboarding-step';
/** Persisted model choice so a relaunch doesn't reset the picker. */
export const ONBOARDING_MODEL_KEY = 'beside:onboarding-model';
