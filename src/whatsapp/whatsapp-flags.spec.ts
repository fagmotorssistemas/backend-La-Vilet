import { resolveWaCloudWebhookFlags } from './whatsapp-flags'

describe('resolveWaCloudWebhookFlags', () => {
  it('defaults to challenge/receive OFF', () => {
    expect(resolveWaCloudWebhookFlags({})).toEqual({
      challengeEnabled: false,
      receiveEnabled: false,
    })
  })

  it('requires exact true', () => {
    expect(
      resolveWaCloudWebhookFlags({
        META_WA_CLOUD_WEBHOOK_CHALLENGE_ENABLED: 'TRUE',
        META_WA_CLOUD_WEBHOOK_RECEIVE_ENABLED: '1',
      }),
    ).toEqual({ challengeEnabled: true, receiveEnabled: false })
  })
})
