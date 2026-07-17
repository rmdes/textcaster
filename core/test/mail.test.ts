import { test, expect } from 'vitest'
import { createMailer } from '../src/mail.ts'

test('createMailer returns null when smtpUrl is null', () => {
  expect(createMailer(null, 'from@ex.test')).toBeNull()
})

test('createMailer builds a mailer for smtp:// and smtps:// urls', () => {
  expect(createMailer('smtp://localhost:1025', 'from@ex.test')).not.toBeNull()
  expect(createMailer('smtps://u:p@mail.ex:465', 'from@ex.test')).not.toBeNull()
})
