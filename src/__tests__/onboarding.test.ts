import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  dismissOnboarding,
  getOnboardingState,
  markWelcomeGuideShown,
  onboardingSentinelPath,
  shouldShowWelcomeGuide,
  welcomeGuideSentinelPath,
} from '../onboarding.js'

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'rivet-onboarding-'))
}

describe('onboarding state', () => {
  it('uses an explicit persisted sentinel path（home 参数即 .rivet 根，RIVET_HOME 覆盖语义）', () => {
    const home = makeHome()

    assert.equal(onboardingSentinelPath(home), join(home, 'onboarding-dismissed'))
    assert.equal(getOnboardingState(home).shouldShow, true)
  })

  it('persists dismissal and hides onboarding afterwards', () => {
    const home = makeHome()

    dismissOnboarding(home)

    assert.equal(getOnboardingState(home).shouldShow, false)
  })
})

describe('welcome guide sentinel (P1-1 欢迎页首启分层)', () => {
  it('paths to welcome-guide-shown under home', () => {
    const home = makeHome()

    assert.equal(welcomeGuideSentinelPath(home), join(home, 'welcome-guide-shown'))
  })

  it('fresh install (no sentinels): show guide', () => {
    const home = makeHome()

    assert.equal(shouldShowWelcomeGuide(home), true)
  })

  it('provider wizard dismissal marks as returning user: skip guide', () => {
    const home = makeHome()

    dismissOnboarding(home)

    assert.equal(shouldShowWelcomeGuide(home), false)
  })

  it('mark once, never shows guide again (idempotent)', () => {
    const home = makeHome()

    markWelcomeGuideShown(home)
    markWelcomeGuideShown(home)

    assert.equal(shouldShowWelcomeGuide(home), false)
    assert.equal(shouldShowWelcomeGuide(home), false, '幂等:重复 mark 不翻转')
  })
})
