import { utils } from "../"
import { getPasswordResetClient } from "./init"

const TTL_SECONDS = 60 * 60

interface PasswordReset {
  userId: string
  info: any
}

/**
 * Given a user ID this will store a code (that is returned) for an hour in redis.
 * The user can then return this code for resetting their password (through their reset link).
 * @param userId the ID of the user which is to be reset.
 * @param info Info about the user/the reset process.
 * @return returns the code that was stored to redis.
 */
export async function createResetPasswordCode(
  userId: string,
  info: any
): Promise<string> {
  const client = await getPasswordResetClient()
  const code = utils.newid()
  await client.store(code, { userId, info }, TTL_SECONDS)
  return code
}

/**
 * Given a reset code this will lookup to redis, check if the code is valid.
 * @param code The code provided via the email link.
 * @return returns the user ID if it is found
 */
export async function getResetPasswordCode(
  code: string
): Promise<PasswordReset> {
  const client = await getPasswordResetClient()
  const value = (await client.get(code)) as PasswordReset | undefined
  if (!value) {
    throw "Provided information is not valid, cannot reset password - please try again."
  }
  return value
}
