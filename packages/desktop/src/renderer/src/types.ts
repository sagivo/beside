export type Screen =
  | 'dashboard'
  | 'meetings'
  | 'privacy'
  | 'search'
  | 'chat'
  | 'connect'
  | 'settings'
  | 'help';

export const ONBOARDING_KEY = 'cofounderos:onboarded';
/**
 * Mid-onboarding progress marker — lets us restore the user to the
 * step they were on if the app relaunches (e.g. after granting
 * Screen Recording, which only takes effect on the next process
 * lifetime).
 */
export const ONBOARDING_STEP_KEY = 'cofounderos:onboarding-step';
/** Persisted model choice so a relaunch doesn't reset the picker. */
export const ONBOARDING_MODEL_KEY = 'cofounderos:onboarding-model';
