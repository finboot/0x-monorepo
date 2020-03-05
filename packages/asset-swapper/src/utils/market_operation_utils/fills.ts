import { BigNumber } from '@0x/utils';

import { constants } from '../../constants';
import { MarketOperation, SignedOrderWithFillableAmounts } from '../../types';

import { DexSample, ERC20BridgeSource, Fill, FillFlags } from './types';

const { ZERO_AMOUNT } = constants;

// tslint:disable: prefer-for-of
// tslint:disable: no-bitwise

/**
 * Create fill paths from orders and dex quotes.
 */
export function createFillPaths(
    side: MarketOperation,
    orders: SignedOrderWithFillableAmounts[],
    dexQuotes: DexSample[][],
    ethToOutputRate: BigNumber,
    fillSize: BigNumber,
    opts: Partial<{
        excludedSources: ERC20BridgeSource[];
        dustFractionThreshold: number;
        fees: { [source: string]: BigNumber };
    }> = {},
): Fill[][] {
    const excludedSources = opts.excludedSources || [];
    const dustFractionThreshold = opts.excludedSources || 0;
    const fees = opts.fees || {};
    // Create native fill paths.
    const nativeFills = orders.map(o => nativeOrderToPath(side, o, ethToOutputRate, fees));
    // Create DEX fill paths.
    const dexPaths = dexQuotesToPaths(side, dexQuotes, ethToOutputRate, fees);
    const paths = filterPaths(
        [...dexPaths, ...nativeFills],
        excludedSources,
        dustFractionThreshold,
    );
}

function nativeOrderToPath(
    side: MarketOperation,
    order: SignedOrderWithFillableAmounts,
    ethToOutputRate: BigNumber,
    fees: { [source: string]: BigNumber },
): Fill[] {
    const path: Fill[] = [];
    for (let i = 0; i < orders.length; i++) {
        const order = orders[i];
        const makerAmount = fillableAmountsUtils.getMakerAssetAmountSwappedAfterOrderFees(order);
        const takerAmount = fillableAmountsUtils.getTakerAssetAmountSwappedAfterOrderFees(order);
        // Native orders can be filled in any order, so they're all root nodes.
        path.push({
            flags: FillFlags.SourceNative,
            exclusionMask: 0,
            input: takerAmount,
            output: makerAmount,
            // Every fill from native orders incurs a penalty.
            fillPenalty: ethToOutputRate.times(opts.fees[ERC20BridgeSource.Native] || 0),
            fillData: {
                source: ERC20BridgeSource.Native,
                order,
            },
        });
    }
    return path;
}

function dexQuotesToPaths(
    side: MarketOperation,
    dexQuotes: DexSample[][],
    ethToOutputRate: BigNumber,
    fees: { [source: string]: BigNumber },
): Fill[][] {
    const paths: Fill[][] = [];
    for (const quote of dexQuotes) {
        const path: Fill[] = [];
        let prevSample: DexSample | undefined;
        for (let i = 0; i < quote.length; i++) {
            const sample = quote[i];
            // Stop of the sample has zero output, which can occur if the source
            // cannot fill the full amount.
            if (sample.output.isZero()) {
                break;
            }
            path.push({
                input: sample.input.minus(prevSample ? prevSample.input : 0),
                output: sample.output.minus(prevSample ? prevSample.output : 0),
                fillPenalty: ZERO_AMOUNT,
                parent: path.length !== 0 ? path[path.length - 1] : undefined,
                flags: sourceToFillFlags(sample.source),
                fillData: { source: sample.source },
            });
            prevSample = quote[i];
        }
        if (path.length > 0) {
            // Only the first fill in a DEX path incurs a penalty.
            path[0].fillPenalty = ethToOutputRate.times(fees[path[0].fillData.source] || 0);
        }
        paths.push(path);
    }
    return paths;
}

function sourceToFillFlags(source: ERC20BridgeSource): number {
    if (source === ERC20BridgeSource.Kyber) {
        return FillFlags.Kyber | FillFlags.Knapsack;
    }
    if (source === ERC20BridgeSource.Eth2Dai) {
        return FillFlags.ConflictsWithKyber;
    }
    if (source === ERC20BridgeSource.Uniswap) {
        return FillFlags.ConflictsWithKyber;
    }
    return 0;
}

function createSellPathFromNativeOrders(
    orders: SignedOrderWithFillableAmounts[],
    ethToOutputRate: BigNumber,
    opts: GetMarketOrdersOpts,
): Fill[] {
    const path: Fill[] = [];
    // tslint:disable-next-line: prefer-for-of
    for (let i = 0; i < orders.length; i++) {
        const order = orders[i];
        const makerAmount = fillableAmountsUtils.getMakerAssetAmountSwappedAfterOrderFees(order);
        const takerAmount = fillableAmountsUtils.getTakerAssetAmountSwappedAfterOrderFees(order);
        // Native orders can be filled in any order, so they're all root nodes.
        path.push({
            flags: FillFlags.SourceNative,
            exclusionMask: 0,
            input: takerAmount,
            output: makerAmount,
            // Every fill from native orders incurs a penalty.
            fillPenalty: ethToOutputRate.times(opts.fees[ERC20BridgeSource.Native] || 0),
            fillData: {
                source: ERC20BridgeSource.Native,
                order,
            },
        });
    }
    return path;
}

function pruneNativeFills(fills: Fill[], fillAmount: BigNumber, dustFractionThreshold: number): Fill[] {
    const minInput = fillAmount.times(dustFractionThreshold);
    const pruned = [];
    let totalInput = ZERO_AMOUNT;
    for (const fill of fills) {
        if (totalInput.gte(fillAmount)) {
            break;
        }
        if (fill.input.lt(minInput)) {
            continue;
        }
        totalInput = totalInput.plus(fill.input);
        pruned.push(fill);
    }
    return pruned;
}

/**
 * Compute the total output minus penalty for a fill path, optionally clipping the input
 * to `maxInput`.
 */
export function getPathAdjustedOutput(path: Fill[], maxInput?: BigNumber): BigNumber {
    let currentInput = ZERO_AMOUNT;
    let currentOutput = ZERO_AMOUNT;
    let currentPenalty = ZERO_AMOUNT;
    for (const fill of path) {
        currentPenalty = currentPenalty.plus(fill.fillPenalty);
        if (maxInput && currentInput.plus(fill.input).gte(maxInput)) {
            const partialInput = maxInput.minus(currentInput);
            currentOutput = currentOutput.plus(getPartialFillOutput(fill, partialInput));
            currentInput = partialInput;
            break;
        } else {
            currentInput = currentInput.plus(fill.input);
            currentOutput = currentOutput.plus(fill.output);
        }
    }
    return currentOutput.minus(currentPenalty);
}

/**
 * Compares two rewards, returning -1, 0, or 1
 * if `a` is less than, equal to, or greater than `b`.
 */
export function comparePathOutputs(a: BigNumber, b: BigNumber, shouldMinimize: boolean): number {
    return shouldMinimize ? b.comparedTo(a) : a.comparedTo(b);
}

// Get the partial output earned by a fill at input `partialInput`.
function getPartialFillOutput(fill: Fill, partialInput: BigNumber): BigNumber {
    return BigNumber.min(fill.output, fill.output.div(fill.input).times(partialInput));
}

/**
 * Sort a path by adjusted input -> output rate while keeping sub-fills contiguous.
 */
export function sortFillsByAdjustedRate(path: Fill[], shouldMinimize: boolean = false): Fill[] {
    return path.slice(0).sort((a, b) => {
        const rootA = getFillRoot(a);
        const rootB = getFillRoot(b);
        const adjustedRateA = rootA.output.minus(rootA.fillPenalty).div(rootA.input);
        const adjustedRateB = rootB.output.minus(rootB.fillPenalty).div(rootB.input);
        if ((!a.parent && !b.parent) || a.fillData.source !== b.fillData.source) {
            return shouldMinimize ? adjustedRateA.comparedTo(adjustedRateB) : adjustedRateB.comparedTo(adjustedRateA);
        }
        if (isFillAncestorOf(a, b)) {
            return -1;
        }
        if (isFillAncestorOf(b, a)) {
            return 1;
        }
        return 0;
    });
}

function getFillRoot(fill: Fill): Fill {
    let root = fill;
    while (root.parent) {
        root = root.parent;
    }
    return root;
}

function isFillAncestorOf(ancestor: Fill, fill: Fill): boolean {
    let currFill = fill.parent;
    while (currFill) {
        if (currFill === ancestor) {
            return true;
        }
        currFill = currFill.parent;
    }
    return false;
}
