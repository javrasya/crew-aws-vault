// What a crew workflow config imports as `crew-aws-vault` (crew's docs/extensions.md, "Credential
// sources" and "Harness logins"): the aws-vault credential source, and a Bedrock login for Claude
// Code and pi that runs on its keys.
import { credentialSource, harnessLogin } from '@crew/sdk'

export const awsVault = credentialSource<{ profile: string }>('aws-vault', { kind: 'aws', describe: 'Keys aws-vault exports for a profile.' })

type Bedrock = { credentials: string; region: string }

// The env sets the region only: crew refuses a login that picks the provider or the model, which stay
// the operator's (CLAUDE_CODE_USE_BEDROCK, the model id) in the agent's role.
export const bedrockLogin = harnessLogin<Bedrock>('bedrock', {
  harnesses: ['claude-code', 'pi'],
  credentials: 'aws',
  hosts: ({ region }) => [`bedrock-runtime.${region}.amazonaws.com`],
  env: ({ region }) => ({ AWS_REGION: region }),
  describe: 'Claude Code or pi on Amazon Bedrock, with keys from a bound aws source.',
})
