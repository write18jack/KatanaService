package com.example.katana

import com.example.katana.models.KatanaResponse
import io.ktor.client.*
import io.ktor.client.call.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.request.*
import io.ktor.client.statement.HttpResponse
import io.ktor.serialization.kotlinx.json.*
import kotlinx.serialization.json.Json

/*
* API通信を管理するクラス
*/
class KatanaApiClient {
    private val client = HttpClient {
        // JSONの変換設定
        install(ContentNegotiation) {
            json(Json {
                prettyPrint = true
                isLenient = true
                ignoreUnknownKeys = true // API側にある id や createdAt などの未知のキーを許容
            })
        }
        // タイムアウト設定を追加
        install(io.ktor.client.plugins.HttpTimeout) {
            requestTimeoutMillis = 15000
            connectTimeoutMillis = 15000
            socketTimeoutMillis = 15000
        }
    }

    // Next.js のベースURL (開発環境に合わせて変更してください) 10.0.2.2:3000
    // Androidエミュレータの場合は 10.0.2.2 を使用
    private val baseUrl = "http://192.168.2.100:3000/api"

    /**
     * 刀剣一覧を取得する (GET /api/katana)
     */
    suspend fun fetchKatanas(): List<KatanaResponse> {
        return try {
            val response: HttpResponse = client.get("$baseUrl/katana")
            println("HTTPステータス: ${response.status}") // デバッグ用
            response.body()
        } catch (e: Exception) {
            // ここでスタックトレースをすべて出力させる
            println("--- 通信エラー詳細 ---")
            e.printStackTrace()
            println("メッセージ: ${e.message}")
            println("----------------------")
            emptyList()
        }
    }
}