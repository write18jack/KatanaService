package com.example.katana

import com.example.katana.models.KatanaRequest
import com.example.katana.models.KatanaResponse
import io.ktor.client.*
import io.ktor.client.call.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.request.*
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.*
import kotlinx.serialization.Serializable
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
                isLenient = true // 多少のフォーマットの緩さを許容
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
    private val baseUrl = "http://192.168.2.103:3000/api"

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

    /**
     * 刀剣データを追加する
     * @param request
     * @return 成功したら true, それ以外は false
     */
    suspend fun addKatana(
        request: KatanaRequest
    ): Boolean {
        return try {
            val response = client.post("$baseUrl/katana") {
                // JSON形式で送ることを明示
                contentType(ContentType.Application.Json)

                // Next.jsのAPIが期待するJSON構造を組み立てる
                setBody(request) // クラスを渡すと Ktor が正しくシリアライズしてくれる
            }
            // デバッグ用：レスポンスコードをログに出すとトラブルシュートが楽です
            println("POST Response Status: ${response.status}")

            // 200 OK や 201 Created なら成功とみなす
            response.status.isSuccess()
        } catch (e: Exception) {
            when (e) {
                is io.ktor.client.network.sockets.ConnectTimeoutException -> {
                    println("接続タイムアウト：サーバーが起動していないか、IPアドレスが違います")
                }

                else -> {
                    println("予期せぬエラー: ${e.message}")
                }
            }
            e.printStackTrace()
            false
        }
    }

    /**
     * 刀剣データを更新する (PUT /api/katana?id=xxx)
     * @param shopName 店舗名
     * @param name 刀名
     * @param era 時代
     * @param price 価格
     * @param dealerId 所持者ID
     * @param imageUrl 画像URL
     * @return 成功したら true, それ以外は false
     */
    suspend fun updateKatana(
        id: String,
        request: KatanaRequest
    ): Boolean {
        return try {
            println("Debug: updateKatana started for ID: $id")
            val response = client.put("$baseUrl/katana") {
                // どのデータを更新するかIDを指定
                parameter("id", id)
                contentType(ContentType.Application.Json)

                // 更新する内容をBodyにセット
                setBody(request) // クラスを渡すと Ktor が正しくシリアライズしてくれる
            }
            println("Debug: PUT Response Status: ${response.status}")
            response.status.isSuccess()
        } catch (e: Exception) {
            println("Debug: Update Failed. Reason: ${e.message}")
            e.printStackTrace()
            false
        }
    }

    /**
     * 刀剣を削除する (DELETE /api/katana?id=xxx)
     * @param id 刀剣データID
     * @param dealerId 所持者ID
     * @return 成功したら true, それ以外は false
     */
    suspend fun deleteKatana(id: String, dealerId: String): Boolean {
        return try {
            // Next.js側でクエリパラメータかBodyでIDを受け取る想定
            val response = client.delete("$baseUrl/katana") {
                parameter("id", id) // URLパラメータとして送る場合
                parameter("dealerId", dealerId)
            }
            println("DELETE Response Status: ${response.status}")
            response.status.isSuccess()
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    suspend fun login(name: String, password: String): UserResponse? {
        return try {
            val response = client.post("$baseUrl/login") {
                contentType(ContentType.Application.Json)
                setBody(mapOf("name" to name, "password" to password))
            }
            if (response.status == HttpStatusCode.OK) {
                response.body<UserResponse>()
            } else {
                null
            }
        } catch (e: Exception) {
            null
        }
    }

    // レスポンスを受けるためのデータクラス
    @Serializable
    data class UserResponse(
        val id: String,
        val name: String,
        val role: String
    )
}