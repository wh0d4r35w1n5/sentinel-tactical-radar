# SentinelBenchStrategy — benchmark strategy for the freqtrade dry-run rig.
# Design intent: a *credible public baseline*, not a strawman. Trend-filtered
# pullback entry on the 1h timeframe (same horizon as the sentinel engine):
#   * EMA50 > EMA200 = uptrend gate
#   * RSI(14) pullback into 35-50 while trend intact = entry
#   * ADX > 20 to skip dead chop (the regime our engine calls 'regime-chop')
# Exits: fixed stoploss, ROI ladder, trailing stop once past 1.5%.
# Dry-run only — this rig has NO exchange keys and dry_run never sends orders.
from datetime import datetime
from pandas import DataFrame
import talib.abstract as ta
from freqtrade.strategy import IStrategy


class SentinelBenchStrategy(IStrategy):
    timeframe = "1h"
    stoploss = -0.025
    trailing_stop = True
    trailing_stop_positive = 0.012
    trailing_stop_positive_offset = 0.02
    trailing_only_offset_is_reached = True
    minimal_roi = {"0": 0.06, "120": 0.03, "360": 0.015, "720": 0.005}
    process_only_new_candles = True
    startup_candle_count = 210
    can_short = False  # spot benchmark — direction accuracy is the comparison
    use_exit_signal = True
    exit_profit_only = False
    ignore_roi_if_entry_signal = False

    def populate_indicators(self, df: DataFrame, metadata: dict) -> DataFrame:
        df["ema50"] = ta.EMA(df, timeperiod=50)
        df["ema200"] = ta.EMA(df, timeperiod=200)
        df["rsi"] = ta.RSI(df, timeperiod=14)
        df["adx"] = ta.ADX(df, timeperiod=14)
        df["atr"] = ta.ATR(df, timeperiod=14)
        # volume confirmation — pullback entries need participation to mean anything
        df["vol_sma"] = df["volume"].rolling(20).mean()
        return df

    def populate_entry_trend(self, df: DataFrame, metadata: dict) -> DataFrame:
        df.loc[
            (df["ema50"] > df["ema200"])
            & (df["rsi"] > 35) & (df["rsi"] < 50)
            & (df["rsi"] > df["rsi"].shift(1))          # RSI turning up off the dip
            & (df["adx"] > 20)
            & (df["volume"] > df["vol_sma"] * 0.6)
            & (df["close"] > df["ema50"] * 0.98),       # price still near/at the trend
            "enter_long",
        ] = 1
        return df

    def populate_exit_trend(self, df: DataFrame, metadata: dict) -> DataFrame:
        df.loc[
            (df["rsi"] > 70) | (df["close"] < df["ema50"] * 0.97) | (df["ema50"] < df["ema200"]),
            "exit_long",
        ] = 1
        return df
