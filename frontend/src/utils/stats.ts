import { BigNumber, BigNumberish } from 'ethers'
import { toChecksumAddress } from 'web3-utils'
import { formatUnits } from 'ethers/lib/utils'
import {
  getBalanceLocked,
  getCurrentUnlockedRewards,
  getCurrentVaultReward,
  getFutureUnlockedRewards,
} from '../sdk/stats'
import {
  Geyser,
  GeyserStats,
  Lock,
  RewardTokenInfo,
  SignerOrProvider,
  StakingTokenInfo,
  TokenInfo,
  UserStats,
  Vault,
  VaultStats,
  VaultTokenBalance,
} from '../types'
import { ERC20Balance } from '../sdk'
import { DAY_IN_SEC, GEYSER_STATS_CACHE_TIME_MS, YEAR_IN_SEC } from '../constants'
import { getCurrentPrice } from './price'
import * as ls from './cache'

const nowInSeconds = () => Math.round(Date.now() / 1000)

export const defaultUserStats = (): UserStats => ({
  apy: 0,
  currentMultiplier: 1.0,
  currentReward: 0,
})

export const defaultGeyserStats = (): GeyserStats => ({
  duration: 0,
  totalDeposit: 0,
  totalRewards: 0,
  calcPeriodInDays: 0,
})

export const defaultVaultStats = (): VaultStats => ({
  id: '',
  stakingTokenBalance: 0,
  rewardTokenBalance: 0,
  vaultTokenBalances: [],
  currentStake: 0,
})

const getGeyserDuration = (geyser: Geyser) => {
  const now = nowInSeconds()
  const { rewardSchedules } = geyser
  const schedulesEndTime = rewardSchedules.map(
    (schedule) => parseInt(schedule.start, 10) + parseInt(schedule.duration, 10),
  )
  return Math.max(...schedulesEndTime.map((endTime) => endTime - now), 0)
}

export const getCalcPeriod = (geyser: Geyser) => {
  const { scalingTime } = geyser
  const geyserDuration = getGeyserDuration(geyser)
  return Math.max(Math.min(geyserDuration, parseInt(scalingTime, 10)), DAY_IN_SEC)
}

const getGeyserTotalDeposit = (geyser: Geyser, stakingTokenInfo: StakingTokenInfo) => {
  const { totalStake } = geyser
  const { decimals } = stakingTokenInfo
  const stakingTokenAmount = parseFloat(formatUnits(totalStake, decimals))
  return stakingTokenAmount * stakingTokenInfo.price
}

export const getGeyserStats = async (
  geyser: Geyser,
  stakingTokenInfo: StakingTokenInfo,
  rewardTokenInfo: RewardTokenInfo,
): Promise<GeyserStats> =>
  ls.computeAndCache<GeyserStats>(
    async () => ({
      duration: getGeyserDuration(geyser),
      totalDeposit: getGeyserTotalDeposit(geyser, stakingTokenInfo),
      totalRewards: await rewardTokenInfo.getTotalRewards(geyser.rewardSchedules),
      calcPeriodInDays: getCalcPeriod(geyser) / DAY_IN_SEC,
    }),
    `${toChecksumAddress(geyser.id)}|stats`,
    GEYSER_STATS_CACHE_TIME_MS,
  )

const getTotalStakeUnits = (geyser: Geyser, timestamp: number) => {
  const { totalStake, totalStakeUnits: cachedTotalStakeUnits, lastUpdate } = geyser
  const lastUpdateTime = parseInt(lastUpdate, 10)
  const durationSinceLastUpdate = Math.max(timestamp - lastUpdateTime, 0)
  return BigNumber.from(cachedTotalStakeUnits).add(BigNumber.from(totalStake).mul(durationSinceLastUpdate))
}

const getLockStakeUnits = (lock: Lock, timestamp: number) => {
  const { amount, stakeUnits: cachedStakeUnits, lastUpdate } = lock
  const lastUpdateTime = parseInt(lastUpdate, 10)
  const durationSinceLastUpdate = Math.max(timestamp - lastUpdateTime, 0)
  return BigNumber.from(cachedStakeUnits).add(BigNumber.from(amount).mul(durationSinceLastUpdate))
}

/**
 * Returns the amount of reward token that will be unlocked between now and `end`
 */
const getPoolDrip = async (geyser: Geyser, end: number, signerOrProvider: SignerOrProvider) => {
  const geyserAddress = toChecksumAddress(geyser.id)
  return (await getFutureUnlockedRewards(geyserAddress, end, signerOrProvider)).sub(
    await getCurrentUnlockedRewards(geyserAddress, signerOrProvider),
  )
}

/**
 * Returns the amount of reward that the user (vault) will receive after `duration` seconds
 * from the stakes in `lock` and `additionalStakes`, assuming that the max reward multiplier will be
 * achieved after `duration` seconds
 */
export const getUserDrip = async (
  geyser: Geyser,
  lock: Lock,
  additionalStakes: BigNumberish,
  duration: number,
  signerOrProvider: SignerOrProvider,
) => {
  const now = nowInSeconds()
  const afterDuration = now + duration
  const poolDrip = await getPoolDrip(geyser, afterDuration, signerOrProvider)
  const stakeUnitsFromAdditionalStake = BigNumber.from(additionalStakes).mul(duration)
  const totalStakeUnitsAfterDuration = getTotalStakeUnits(geyser, afterDuration).add(stakeUnitsFromAdditionalStake)
  const lockStakeUnitsAfterDuration = getLockStakeUnits(lock, afterDuration).add(stakeUnitsFromAdditionalStake)
  if (totalStakeUnitsAfterDuration.isZero()) return 0
  return (
    parseInt(poolDrip.mul(lockStakeUnitsAfterDuration).toString(), 10) /
    parseInt(totalStakeUnitsAfterDuration.toString(), 10)
  )
}

export const getUserDripAfterWithdraw = async (
  geyser: Geyser,
  lock: Lock,
  withdrawAmount: BigNumberish,
  duration: number,
  signerOrProvider: SignerOrProvider,
) => getUserDrip(geyser, lock, BigNumber.from('0').sub(withdrawAmount), duration, signerOrProvider)

export const getStakeDrip = async (
  geyser: Geyser,
  stake: BigNumberish,
  duration: number,
  signerOrProvider: SignerOrProvider,
) => {
  const now = nowInSeconds()
  const afterDuration = now + duration
  const poolDrip = await getPoolDrip(geyser, afterDuration, signerOrProvider)
  const stakeUnitsFromStake = BigNumber.from(stake).mul(duration)
  const totalStakeUnitsAfterDuration = getTotalStakeUnits(geyser, afterDuration).add(stakeUnitsFromStake)
  if (totalStakeUnitsAfterDuration.isZero()) return 0
  return (
    parseInt(poolDrip.mul(stakeUnitsFromStake).toString(), 10) / parseInt(totalStakeUnitsAfterDuration.toString(), 10)
  )
}

const calculateAPY = (inflow: number, outflow: number, periods: number) => (1 + outflow / inflow) ** periods - 1

/**
 * APY = (1 + (outflow / inflow)) ** periods - 1
 *
 * inflow = (amount staked by vault * price of the staking token)
 * outflow = (reward that will be unlocked by vault in the next `scalingTime * price of reward token)
 * periods = number of `calcPeriod` in a year
 *
 * calcPeriod = max(min(geyserDuration, scalingTime), day)
 */
export const getUserAPY = async (
  geyser: Geyser,
  lock: Lock | null,
  stakingTokenInfo: StakingTokenInfo,
  rewardTokenInfo: TokenInfo,
  additionalStakes: BigNumberish,
  signerOrProvider: SignerOrProvider,
) => {
  const { scalingTime } = geyser
  const { decimals: stakingTokenDecimals, price: stakingTokenPrice } = stakingTokenInfo
  const { decimals: rewardTokenDecimals, symbol: rewardTokenSymbol } = rewardTokenInfo
  const rewardTokenPrice = await getCurrentPrice(rewardTokenSymbol)
  const calcPeriod = getCalcPeriod(geyser)
  const drip = await (lock
    ? getUserDrip(geyser, lock, additionalStakes, parseInt(scalingTime, 10), signerOrProvider)
    : getStakeDrip(geyser, additionalStakes, parseInt(scalingTime, 10), signerOrProvider))

  const stakedAmount = BigNumber.from(additionalStakes)
    .add(lock ? lock.amount : '0')
    .toString()
  const inflow = parseFloat(formatUnits(stakedAmount, stakingTokenDecimals)) * stakingTokenPrice
  const outflow = parseFloat(formatUnits(Math.round(drip), rewardTokenDecimals)) * rewardTokenPrice
  const periods = YEAR_IN_SEC / calcPeriod
  return calculateAPY(inflow, outflow, periods)
}

/**
 * Pool APY is the APY for a user who makes an average deposit at the current moment in time
 */
const getPoolAPY = async (
  geyser: Geyser,
  stakingTokenInfo: StakingTokenInfo,
  rewardTokenInfo: TokenInfo,
  signerOrProvider: SignerOrProvider,
) =>
  ls.computeAndCache<number>(
    async () => {
      const { scalingTime } = geyser
      const { price: stakingTokenPrice } = stakingTokenInfo
      const { decimals: rewardTokenDecimals, symbol: rewardTokenSymbol } = rewardTokenInfo
      if (!rewardTokenSymbol) return 0
      const rewardTokenPrice = await getCurrentPrice('AMPL')

      const inflow = 20000.0 // avg_deposit: 20,000 USD

      const stake = BigNumber.from(Math.round(inflow / stakingTokenPrice))
      const calcPeriod = getCalcPeriod(geyser)
      const stakeDripAfterPeriod = await getStakeDrip(geyser, stake, parseInt(scalingTime, 10), signerOrProvider)
      if (stakeDripAfterPeriod === 0) return 0

      const outflow = parseFloat(formatUnits(Math.round(stakeDripAfterPeriod), rewardTokenDecimals)) * rewardTokenPrice
      const periods = YEAR_IN_SEC / calcPeriod
      return calculateAPY(inflow, outflow, periods)
    },
    `${toChecksumAddress(geyser.id)}|poolAPY`,
    GEYSER_STATS_CACHE_TIME_MS,
  )

/**
 * Reward multiplier for the stakes of a vault on a geyser
 *
 * The minimum multiplier is 1, and the maximum multiplier is scalingCeiling / scalingFloor
 *
 * If the current multiplier were maxed, then the rewards from unstaking all stakes
 * would be maxRewards = (currentUnlockedRewards * lockStakeUnits / totalStakeUnits)
 *
 * The actual current multiplier is then { minMultiplier + currentRewards / maxRewards * (maxMultiplier - minMultiplier) }
 */
const getCurrentMultiplier = async (geyser: Geyser, vault: Vault, lock: Lock, signerOrProvider: SignerOrProvider) => {
  const { scalingFloor, scalingCeiling } = geyser
  const geyserAddress = toChecksumAddress(geyser.id)
  const vaultAddress = toChecksumAddress(vault.id)

  const now = nowInSeconds()
  const minMultiplier = 1
  const maxMultiplier = parseInt(scalingCeiling, 10) / parseInt(scalingFloor, 10)
  const totalStakeUnits = getTotalStakeUnits(geyser, now)
  const lockStakeUnits = getLockStakeUnits(lock, now)
  if (totalStakeUnits.isZero() || lockStakeUnits.isZero()) return minMultiplier

  const currentUnlockedRewards = await getCurrentUnlockedRewards(geyserAddress, signerOrProvider)
  if (currentUnlockedRewards.isZero()) return minMultiplier

  const currentRewards = parseInt(
    (await getCurrentVaultReward(vaultAddress, geyserAddress, signerOrProvider)).toString(),
    10,
  )
  const maxRewards =
    parseInt(currentUnlockedRewards.mul(lockStakeUnits).toString(), 10) / parseInt(totalStakeUnits.toString(), 10)
  const fraction = currentRewards / maxRewards

  return minMultiplier + fraction * (maxMultiplier - minMultiplier)
}

export const getUserStats = async (
  geyser: Geyser,
  vault: Vault | null,
  lock: Lock | null,
  stakingTokenInfo: StakingTokenInfo,
  rewardTokenInfo: TokenInfo,
  signerOrProvider: SignerOrProvider,
): Promise<UserStats> => {
  if (!vault || !lock) {
    return {
      ...defaultUserStats(),
      apy: await getPoolAPY(geyser, stakingTokenInfo, rewardTokenInfo, signerOrProvider),
    }
  }
  const vaultAddress = toChecksumAddress(vault.id)
  const geyserAddress = toChecksumAddress(geyser.id)
  const { decimals: rewardTokenDecimals } = rewardTokenInfo
  const { amount } = lock
  const currentRewards = await getCurrentVaultReward(vaultAddress, geyserAddress, signerOrProvider)
  const formattedCurrentRewards = parseFloat(formatUnits(currentRewards, rewardTokenDecimals))
  const apy = BigNumber.from(amount).isZero()
    ? await getPoolAPY(geyser, stakingTokenInfo, rewardTokenInfo, signerOrProvider)
    : await getUserAPY(geyser, lock, stakingTokenInfo, rewardTokenInfo, 0, signerOrProvider)
  return {
    apy,
    currentMultiplier: await getCurrentMultiplier(geyser, vault, lock, signerOrProvider),
    currentReward: formattedCurrentRewards,
  }
}

const getVaultTokenBalance = async (
  tokenInfo: TokenInfo,
  vaultAddress: string,
  signerOrProvider: SignerOrProvider,
): Promise<VaultTokenBalance> => {
  const tokenAddress = toChecksumAddress(tokenInfo.address)
  const parsedBalance = await ERC20Balance(tokenAddress, vaultAddress, signerOrProvider)
  const lockedBalance = await getBalanceLocked(vaultAddress, tokenAddress, signerOrProvider)
  const parsedUnlockedBalance = parsedBalance.sub(lockedBalance)
  const balance = parseFloat(formatUnits(parsedBalance, tokenInfo.decimals))
  const unlockedBalance = parseFloat(formatUnits(parsedUnlockedBalance, tokenInfo.decimals))

  return {
    ...tokenInfo,
    address: tokenAddress,
    parsedBalance,
    balance,
    unlockedBalance,
    parsedUnlockedBalance,
  }
}

export const getVaultStats = async (
  stakingTokenInfo: StakingTokenInfo,
  rewardTokenInfo: RewardTokenInfo,
  allTokensInfos: TokenInfo[],
  vault: Vault | null,
  lock: Lock | null,
  signerOrProvider: SignerOrProvider,
): Promise<VaultStats> => {
  if (!vault) return defaultVaultStats()
  const vaultAddress = toChecksumAddress(vault.id)

  const addressSet = new Set<string>([stakingTokenInfo.address, rewardTokenInfo.address].map(toChecksumAddress))
  const stakingTokenBalanceInfo = await getVaultTokenBalance(stakingTokenInfo, vaultAddress, signerOrProvider)
  const rewardTokenBalanceInfo = await getVaultTokenBalance(rewardTokenInfo, vaultAddress, signerOrProvider)

  const additionalTokenBalances: VaultTokenBalance[] = (
    await Promise.allSettled(
      allTokensInfos
        .map((tokenInfo) => ({ ...tokenInfo, address: toChecksumAddress(tokenInfo.address) }))
        .filter(({ address }) => {
          const isDuplicate = addressSet.has(address)
          if (!isDuplicate) addressSet.add(address)
          return !isDuplicate
        })
        .map((tokenInfo) => getVaultTokenBalance(tokenInfo, vaultAddress, signerOrProvider)),
    )
  )
    .filter(({ status }) => status === 'fulfilled')
    .map((result) => (result as PromiseFulfilledResult<VaultTokenBalance>).value)

  const vaultTokenBalances = [stakingTokenBalanceInfo, rewardTokenBalanceInfo]
    .concat(additionalTokenBalances)
    .sort((a, b) => (a.symbol < b.symbol ? -1 : 1))

  const amount = lock ? lock.amount : '0'
  const currentStake = parseFloat(formatUnits(amount, stakingTokenInfo.decimals))

  return {
    id: vaultAddress,
    stakingTokenBalance: stakingTokenBalanceInfo.balance,
    rewardTokenBalance: rewardTokenBalanceInfo.balance,
    vaultTokenBalances,
    currentStake,
  }
}
