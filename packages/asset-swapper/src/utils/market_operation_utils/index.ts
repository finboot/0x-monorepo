import { ContractAddresses } from '@0x/contract-addresses';
import { assetDataUtils, ERC20AssetData, orderCalculationUtils } from '@0x/order-utils';
import { SignedOrder } from '@0x/types';
import { BigNumber } from '@0x/utils';

import { constants } from '../../constants';
import { MarketOperation, SignedOrderWithFillableAmounts } from '../../types';
import { fillableAmountsUtils } from '../fillable_amounts_utils';
import { utils } from '../utils';

import { constants as marketOperationUtilConstants } from './constants';
import { CreateOrderUtils } from './create_order';
import { comparePathOutputs, FillsOptimizer, getPathAdjustedOutput, sortFillsByAdjustedRate } from './fill_optimizer';
import { createFillPaths } from './fills';
import { DexOrderSampler, getSampleAmounts } from './sampler';
import {
    AggregationError,
    CollapsedFill,
    DexSample,
    ERC20BridgeSource,
    Fill,
    FillData,
    FillFlags,
    GetMarketOrdersOpts,
    NativeCollapsedFill,
    NativeFillData,
    OptimizedMarketOrder,
    OrderDomain,
} from './types';

export { DexOrderSampler } from './sampler';

const { ZERO_AMOUNT } = constants;
const {
    BUY_SOURCES,
    DEFAULT_GET_MARKET_ORDERS_OPTS,
    ERC20_PROXY_ID,
    FEE_QUOTE_SOURCES,
    ONE_ETHER,
    SELL_SOURCES,
} = marketOperationUtilConstants;
const { difference } = utils;

export class MarketOperationUtils {
    private readonly _wethAddress: string;

    constructor(
        private readonly _sampler: DexOrderSampler,
        private readonly contractAddresses: ContractAddresses,
        private readonly _orderDomain: OrderDomain,
    ) {
        this._wethAddress = contractAddresses.etherToken.toLowerCase();
    }

    /**
     * gets the orders required for a market sell operation by (potentially) merging native orders with
     * generated bridge orders.
     * @param nativeOrders Native orders.
     * @param takerAmount Amount of taker asset to sell.
     * @param opts Options object.
     * @return orders.
     */
    public async getMarketSellOrdersAsync(
        nativeOrders: SignedOrder[],
        takerAmount: BigNumber,
        opts?: Partial<GetMarketOrdersOpts>,
    ): Promise<OptimizedMarketOrder[]> {
        if (nativeOrders.length === 0) {
            throw new Error(AggregationError.EmptyOrders);
        }
        const _opts = {
            ...DEFAULT_GET_MARKET_ORDERS_OPTS,
            ...opts,
        };
        const [makerToken, takerToken] = getOrderTokens(nativeOrders[0]);
        // Call the sampler contract.
        const [fillableAmounts, ethToMakerAssetRate, dexQuotes] = await this._sampler.executeAsync(
            // Get fillable amounts for native orders
            DexOrderSampler.ops.getOrderFillableTakerAmounts(nativeOrders),
            // Get ETH -> maker token price.
            makerToken === this._wethAddress
                ? DexOrderSampler.ops.constant(new BigNumber(1))
                : DexOrderSampler.ops.getMedianSellRate(
                      difference(FEE_QUOTE_SOURCES, _opts.excludedSources),
                      makerToken,
                      this._wethAddress,
                      ONE_ETHER,
                  ),
            // Get sell quotes for taker -> maker.
            DexOrderSampler.ops.getSellQuotes(
                difference(SELL_SOURCES, _opts.excludedSources),
                makerToken,
                takerToken,
                getSampleAmounts(takerAmount, _opts.numSamples, _opts.sampleDistributionBase),
            ),
        );
        // Convert native orders and dex quotes into fill paths.
        const paths = createFillPaths(
            MarketOperation.Sell,
            // Augment native orders with their fillable amounts.
            createSignedOrdersWithFillableAmounts(
                MarketOperation.Sell,
                nativeOrders,
                fillableAmounts,
            ),
            dexQuotes,
            ethToMakerAssetRate,
            takerAmount,
            _opts,
        );
        // Find the optimal path.
        const path = findOptimalPath(MarketOperation.Sell, paths, _opts);
        if (!path) {
            throw new Error(AggregationError.NoOptimalPath);
        }
        // Find a fallback path from sources not used in the first path.
        let fallbackPath = [];
        if (_opts.allowFallback) {
            fallbackPath = findOptimalPath(getFallbackPaths(
                MarketOperation.Sell,
                getUnusedSourcePaths(path, paths),
                _opts,
            )) || [];
        }
        return createOrdersFromPath([...path, ...fallbackPath], _opts);

        // Create native fill paths.
        // const nativeFills = pruneNativeFills(
        //     sortFillsByAdjustedRate(
        //         createSellPathFromNativeOrders(nativeOrdersWithFillableAmounts, ethToMakerAssetRate, _opts),
        //     ),
        //     takerAmount,
        //     _opts.dustFractionThreshold,
        // );
        // // Create DEX fill paths.
        // const dexPaths = createSellPathsFromDexQuotes(dexQuotes, ethToMakerAssetRate, _opts);
        // const allPaths = [...dexPaths];
        // const allFills = flattenDexPaths(dexPaths);
        // // If native orders are allowed, splice them in.
        // if (!_opts.excludedSources.includes(ERC20BridgeSource.Native)) {
        //     allPaths.splice(0, 0, nativeFills);
        //     allFills.splice(0, 0, ...nativeFills);
        // }
        //
        // const optimizer = new FillsOptimizer(_opts.runLimit);
        // const upperBoundPath = pickBestUpperBoundPath(allPaths, takerAmount);
        // const optimalPath = optimizer.optimize(
        //     // Sorting the orders by price effectively causes the optimizer to walk
        //     // the greediest solution first, which is the optimal solution in most
        //     // cases.
        //     sortFillsByAdjustedRate(allFills),
        //     takerAmount,
        //     upperBoundPath,
        // );
        // if (!optimalPath) {
        //     throw new Error(AggregationError.NoOptimalPath);
        // }
        // return this._createOrderUtils.createSellOrdersFromPath(
        //     this._orderDomain,
        //     takerToken,
        //     makerToken,
        //     collapsePath(optimalPath, false),
        //     _opts.bridgeSlippage,
        // );
    }

    /**
     * gets the orders required for a market buy operation by (potentially) merging native orders with
     * generated bridge orders.
     * @param nativeOrders Native orders.
     * @param makerAmount Amount of maker asset to buy.
     * @param opts Options object.
     * @return orders.
     */
    public async getMarketBuyOrdersAsync(
        nativeOrders: SignedOrder[],
        makerAmount: BigNumber,
        opts?: Partial<GetMarketOrdersOpts>,
    ): Promise<OptimizedMarketOrder[]> {
        if (nativeOrders.length === 0) {
            throw new Error(AggregationError.EmptyOrders);
        }
        const _opts = {
            ...DEFAULT_GET_MARKET_ORDERS_OPTS,
            ...opts,
        };
        const [makerToken, takerToken] = getOrderTokens(nativeOrders[0]);
        // Call the sampler contract.
        const [fillableAmounts, ethToTakerAssetRate, dexQuotes] = await this._sampler.executeAsync(
            // Get native order fillable amounts.
            DexOrderSampler.ops.getOrderFillableMakerAmounts(nativeOrders),
            // Get ETH -> taker token price.
            takerToken === this._wethAddress
                ? DexOrderSampler.ops.constant(new BigNumber(1))
                : DexOrderSampler.ops.getMedianSellRate(
                      difference(FEE_QUOTE_SOURCES, _opts.excludedSources),
                      takerToken,
                      this._wethAddress,
                      ONE_ETHER,
                  ),
            // Get buy quotes for taker -> maker.
            DexOrderSampler.ops.getBuyQuotes(
                difference(BUY_SOURCES, _opts.excludedSources),
                makerToken,
                takerToken,
                getSampleAmounts(makerAmount, _opts.numSamples, _opts.sampleDistributionBase),
            ),
        );
        // Call the sampler.
        const signedOrderWithFillableAmounts = this._createBuyOrdersPathFromSamplerResultIfExists(
            nativeOrders,
            makerAmount,
            fillableAmounts,
            dexQuotes,
            ethToTakerAssetRate,
            _opts,
        );
        if (!signedOrderWithFillableAmounts) {
            throw new Error(AggregationError.NoOptimalPath);
        }
        return signedOrderWithFillableAmounts;
    }

    /**
     * gets the orders required for a batch of market buy operations by (potentially) merging native orders with
     * generated bridge orders.
     * @param batchNativeOrders Batch of Native orders.
     * @param makerAmounts Array amount of maker asset to buy for each batch.
     * @param opts Options object.
     * @return orders.
     */
    public async getBatchMarketBuyOrdersAsync(
        batchNativeOrders: SignedOrder[][],
        makerAmounts: BigNumber[],
        opts?: Partial<GetMarketOrdersOpts>,
    ): Promise<Array<OptimizedMarketOrder[] | undefined>> {
        if (batchNativeOrders.length === 0) {
            throw new Error(AggregationError.EmptyOrders);
        }
        const _opts = {
            ...DEFAULT_GET_MARKET_ORDERS_OPTS,
            ...opts,
        };

        const sources = difference(BUY_SOURCES, _opts.excludedSources);
        const ops = [
            ...batchNativeOrders.map(orders => DexOrderSampler.ops.getOrderFillableMakerAmounts(orders)),
            ...batchNativeOrders.map(orders =>
                DexOrderSampler.ops.getMedianSellRate(
                    difference(FEE_QUOTE_SOURCES, _opts.excludedSources),
                    this._wethAddress,
                    getOrderTokens(orders[0])[1],
                    ONE_ETHER,
                ),
            ),
            ...batchNativeOrders.map((orders, i) =>
                DexOrderSampler.ops.getBuyQuotes(sources, getOrderTokens(orders[0])[0], getOrderTokens(orders[0])[1], [
                    makerAmounts[i],
                ]),
            ),
        ];
        const executeResults = await this._sampler.executeBatchAsync(ops);
        const batchFillableAmounts = executeResults.splice(0, batchNativeOrders.length) as BigNumber[][];
        const batchEthToTakerAssetRate = executeResults.splice(0, batchNativeOrders.length) as BigNumber[];
        const batchDexQuotes = executeResults.splice(0, batchNativeOrders.length) as DexSample[][][];

        return batchFillableAmounts.map((fillableAmounts, i) =>
            this._createBuyOrdersPathFromSamplerResultIfExists(
                batchNativeOrders[i],
                makerAmounts[i],
                fillableAmounts,
                batchDexQuotes[i],
                batchEthToTakerAssetRate[i],
                _opts,
            ),
        );
    }

    private _createBuyOrdersPathFromSamplerResultIfExists(
        nativeOrders: SignedOrder[],
        makerAmount: BigNumber,
        nativeOrderFillableAmounts: BigNumber[],
        dexQuotes: DexSample[][],
        ethToTakerAssetRate: BigNumber,
        opts: GetMarketOrdersOpts,
    ): OptimizedMarketOrder[] | undefined {
        const nativeOrdersWithFillableAmounts = createSignedOrdersWithFillableAmounts(
            nativeOrders,
            nativeOrderFillableAmounts,
            MarketOperation.Buy,
        );
        const nativeFills = pruneNativeFills(
            sortFillsByAdjustedRate(
                createBuyPathFromNativeOrders(nativeOrdersWithFillableAmounts, ethToTakerAssetRate, opts),
                true,
            ),
            makerAmount,
            opts.dustFractionThreshold,
        );
        const dexPaths = createBuyPathsFromDexQuotes(dexQuotes, ethToTakerAssetRate, opts);
        const allPaths = [...dexPaths];
        const allFills = flattenDexPaths(dexPaths);
        // If native orders are allowed, splice them in.
        if (!opts.excludedSources.includes(ERC20BridgeSource.Native)) {
            allPaths.splice(0, 0, nativeFills);
            allFills.splice(0, 0, ...nativeFills);
        }
        const optimizer = new FillsOptimizer(opts.runLimit, true);
        const upperBoundPath = pickBestUpperBoundPath(allPaths, makerAmount, true);
        const optimalPath = optimizer.optimize(
            // Sorting the orders by price effectively causes the optimizer to walk
            // the greediest solution first, which is the optimal solution in most
            // cases.
            sortFillsByAdjustedRate(allFills, true),
            makerAmount,
            upperBoundPath,
        );
        if (!optimalPath) {
            return undefined;
        }
        const [inputToken, outputToken] = getOrderTokens(nativeOrders[0]);
        return this._createOrderUtils.createBuyOrdersFromPath(
            this._orderDomain,
            inputToken,
            outputToken,
            collapsePath(optimalPath, true),
            opts.bridgeSlippage,
        );
    }
}

/**
 * Augments native orders with fillable amounts and filters out unfillable orders.
 */
function createSignedOrdersWithFillableAmounts(
    operation: MarketOperation,
    orders: SignedOrder[],
    fillableAmounts: BigNumber[],
): SignedOrderWithFillableAmounts[] {
    return orders
        .map((order: SignedOrder, i: number) => {
            const fillableAmount = fillableAmounts[i];
            const fillableMakerAssetAmount =
                operation === MarketOperation.Buy
                    ? fillableAmount
                    : orderCalculationUtils.getMakerFillAmount(order, fillableAmount);
            const fillableTakerAssetAmount =
                operation === MarketOperation.Sell
                    ? fillableAmount
                    : orderCalculationUtils.getTakerFillAmount(order, fillableAmount);
            const fillableTakerFeeAmount = orderCalculationUtils.getTakerFeeAmount(order, fillableTakerAssetAmount);
            return {
                ...order,
                fillableMakerAssetAmount,
                fillableTakerAssetAmount,
                fillableTakerFeeAmount,
            };
        })
        .filter(order => {
            return !order.fillableMakerAssetAmount.isZero() && !order.fillableTakerAssetAmount.isZero();
        });
}

function createSellPathFromNativeOrders(
    orders: SignedOrderWithFillableAmounts[],
    ethToOutputAssetRate: BigNumber,
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
            fillPenalty: ethToOutputAssetRate.times(opts.fees[ERC20BridgeSource.Native] || 0),
            fillData: {
                source: ERC20BridgeSource.Native,
                order,
            },
        });
    }
    return path;
}

function createBuyPathFromNativeOrders(
    orders: SignedOrderWithFillableAmounts[],
    ethToOutputAssetRate: BigNumber,
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
            input: makerAmount,
            output: takerAmount,
            // Every fill from native orders incurs a penalty.
            // Negated because we try to minimize the output in buys.
            fillPenalty: ethToOutputAssetRate.times(opts.fees[ERC20BridgeSource.Native] || 0).negated(),
            fillData: {
                source: ERC20BridgeSource.Native,
                order,
            },
        });
    }
    return path;
}

function createSellPathsFromDexQuotes(
    dexQuotes: DexSample[][],
    ethToOutputAssetRate: BigNumber,
    opts: GetMarketOrdersOpts,
): Fill[][] {
    return createPathsFromDexQuotes(dexQuotes, ethToOutputAssetRate, opts);
}

function createBuyPathsFromDexQuotes(
    dexQuotes: DexSample[][],
    ethToOutputAssetRate: BigNumber,
    opts: GetMarketOrdersOpts,
): Fill[][] {
    return createPathsFromDexQuotes(
        dexQuotes,
        // Negated because we try to minimize the output in buys.
        ethToOutputAssetRate.negated(),
        opts,
    );
}

function createPathsFromDexQuotes(
    dexQuotes: DexSample[][],
    ethToOutputAssetRate: BigNumber,
    opts: GetMarketOrdersOpts,
): Fill[][] {
    const paths: Fill[][] = [];
    for (const quote of dexQuotes) {
        const path: Fill[] = [];
        let prevSample: DexSample | undefined;
        // tslint:disable-next-line: prefer-for-of
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
                exclusionMask: opts.noConflicts ? sourceToExclusionMask(sample.source) : 0,
                fillData: { source: sample.source },
            });
            prevSample = quote[i];
        }
        // Don't push empty paths.
        if (path.length > 0) {
            // Only the first fill in a DEX path incurs a penalty.
            path[0].fillPenalty = ethToOutputAssetRate.times(opts.fees[path[0].fillData.source] || 0);
            paths.push(path);
        }
    }
    return paths;
}

function sourceToFillFlags(source: ERC20BridgeSource): number {
    if (source === ERC20BridgeSource.Kyber) {
        return FillFlags.SourceKyber;
    }
    if (source === ERC20BridgeSource.Eth2Dai) {
        return FillFlags.SourceEth2Dai;
    }
    if (source === ERC20BridgeSource.Uniswap) {
        return FillFlags.SourceUniswap;
    }
    return FillFlags.SourceNative;
}

function sourceToExclusionMask(source: ERC20BridgeSource): number {
    if (source === ERC20BridgeSource.Kyber) {
        // tslint:disable-next-line: no-bitwise
        return FillFlags.SourceEth2Dai | FillFlags.SourceUniswap;
    }
    if (source === ERC20BridgeSource.Eth2Dai) {
        return FillFlags.SourceKyber;
    }
    if (source === ERC20BridgeSource.Uniswap) {
        return FillFlags.SourceKyber;
    }
    return 0;
}

// Convert a list of DEX paths to a flattened list of `Fills`.
function flattenDexPaths(dexFills: Fill[][]): Fill[] {
    const fills: Fill[] = [];
    for (const quote of dexFills) {
        for (const fill of quote) {
            fills.push(fill);
        }
    }
    return fills;
}

// Picks the path with the highest (or lowest if `shouldMinimize` is true) output.
function pickBestUpperBoundPath(paths: Fill[][], maxInput: BigNumber, shouldMinimize?: boolean): Fill[] | undefined {
    let optimalPath: Fill[] | undefined;
    let optimalPathOutput: BigNumber = ZERO_AMOUNT;
    for (const path of paths) {
        if (getPathInput(path).gte(maxInput)) {
            const output = getPathAdjustedOutput(path, maxInput);
            if (!optimalPath || comparePathOutputs(output, optimalPathOutput, !!shouldMinimize) === 1) {
                optimalPath = path;
                optimalPathOutput = output;
            }
        }
    }
    return optimalPath;
}

// Gets the total input of a path.
function getPathInput(path: Fill[]): BigNumber {
    return BigNumber.sum(...path.map(p => p.input));
}

// Merges contiguous fills from the same DEX.
function collapsePath(path: Fill[], isBuy: boolean): CollapsedFill[] {
    const collapsed: Array<CollapsedFill | NativeCollapsedFill> = [];
    for (const fill of path) {
        const makerAssetAmount = isBuy ? fill.input : fill.output;
        const takerAssetAmount = isBuy ? fill.output : fill.input;
        const source = (fill.fillData as FillData).source;
        if (collapsed.length !== 0 && source !== ERC20BridgeSource.Native) {
            const prevFill = collapsed[collapsed.length - 1];
            // If the last fill is from the same source, merge them.
            if (prevFill.source === source) {
                prevFill.totalMakerAssetAmount = prevFill.totalMakerAssetAmount.plus(makerAssetAmount);
                prevFill.totalTakerAssetAmount = prevFill.totalTakerAssetAmount.plus(takerAssetAmount);
                prevFill.subFills.push({ makerAssetAmount, takerAssetAmount });
                continue;
            }
        }
        collapsed.push({
            source: fill.fillData.source,
            totalMakerAssetAmount: makerAssetAmount,
            totalTakerAssetAmount: takerAssetAmount,
            subFills: [{ makerAssetAmount, takerAssetAmount }],
            nativeOrder: (fill.fillData as NativeFillData).order,
        });
    }
    return collapsed;
}

function getOrderTokens(order: SignedOrder): [string, string] {
    const assets = [order.makerAssetData, order.takerAssetData].map(a => assetDataUtils.decodeAssetDataOrThrow(a)) as [
        ERC20AssetData,
        ERC20AssetData
    ];
    if (assets.some(a => a.assetProxyId !== ERC20_PROXY_ID)) {
        throw new Error(AggregationError.NotERC20AssetData);
    }
    return assets.map(a => a.tokenAddress.toLowerCase()) as [string, string];
}

// tslint:disable: max-file-line-count
