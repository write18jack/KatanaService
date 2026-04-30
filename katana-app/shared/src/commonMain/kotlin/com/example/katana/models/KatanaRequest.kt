package com.example.katana.models

import kotlinx.serialization.Serializable

/**
 * 送信データの本体（Next.js の KatanaInput に相当）
 * @Serializable: これを付けることで、KtorがNext.jsのAPIから
 * 届いたJSONを自動的にこのクラスに変換する
 */
@Serializable
data class KatanaInput(
    val shopName: String,
    val name: String,
    val katanaType: KatanaType,
    val era: String,
    val price: String // 通貨を扱うため、Intより大きなLong、またはDouble推奨
)

/**
 * サーバー側で定義した enum と同期
 */
@Serializable
enum class KatanaType {
    // TypeScriptの enum 定義と文字列を完全に一致させます
    打刀, 脇差, 短刀, 太刀, 薙刀
}

/**
 * サーバーアクション createKatanaRequest(crudType, katanaId, values) の引数を
 * 1つの JSON オブジェクトとして送るためのラッパー
 */
@Serializable
data class KatanaActionRequest(
    val crudType: String,      // "CREATE", "UPDATE", "DELETE"
    val katanaId: String? = null,
    val values: KatanaInput? = null
)

@Serializable
data class KatanaResponse(
    val id: String,
    val shopName: String = "",
    val name: String,
    val katanaType: String,
    val era: String,
    val price: Int,
    val status: String = "",
    val dealerId: String = "",
    val version: Int = 0,
    val imageUrl: String? = null,
    val createdAt: String, // ISO8601形式の文字列として受け取る
    val updatedAt: String
)

@Serializable
data class KatanaRequest(
    val shopName: String,
    val name: String,
    val katanaType: String,
    val era: String,
    val price: Int,
    val imageUrl: String?,
    val dealerId: String? = null
)