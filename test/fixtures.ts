/**
 * Values the tests share.
 *
 * The addresses are derived rather than random so a failing run names the same
 * contract every time, and the authorization shapes live here because both the
 * signer tests and the client tests need to hand the SDK one.
 */
import { Address, StrKey, xdr } from '@stellar/stellar-sdk';

export const PASSPHRASE = 'Test SDF Network ; September 2015';

/** A fixed contract address per role. */
function contract(seed: number): string {
  return StrKey.encodeContract(Buffer.alloc(32, seed));
}

export const CORE = contract(1);
export const POLICY = contract(2);
export const BREAKER = contract(3);
export const MULTISIG = contract(4);

/** `G…` address of a fresh, unrelated account. */
export function accountAddress(seed: number): string {
  return StrKey.encodeEd25519PublicKey(Buffer.alloc(32, seed));
}

export function invocation(
  functionName: string,
  contractAddress: string = CORE,
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    subInvocations: [],
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contractAddress).toScAddress(),
        functionName,
        args: [],
      }),
    ),
  });
}

/** The credentials the account paying for the transaction gets for free. */
export function sourceAccountAuth(functionName: string = 'issue'): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: invocation(functionName),
  });
}

/** The credentials that have to be signed by whoever `address` names. */
export function addressAuth(
  address: string,
  functionName: string = 'issue',
  contractAddress: string = CORE,
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(address).toScAddress(),
        nonce: new xdr.Int64(1n),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVec([]),
      }),
    ),
    rootInvocation: invocation(functionName, contractAddress),
  });
}
