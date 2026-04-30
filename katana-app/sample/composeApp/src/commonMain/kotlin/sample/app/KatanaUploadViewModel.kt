package sample.app

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.katana.KatanaApiClient
import com.example.katana.SupabaseManager
import com.example.katana.models.KatanaRequest
import io.github.jan.supabase.storage.storage
import kotlinx.coroutines.launch
import kotlin.time.Clock
import kotlin.time.ExperimentalTime

class KatanaUploadViewModel(
    private val apiClient: KatanaApiClient
) : ViewModel() {
    private val storage = SupabaseManager.client.storage

    // UI状態の管理（ローディングやエラー表示用）
    var uiState by mutableStateOf<UploadUiState>(UploadUiState.Idle)
        private set

    /**
     * UI状態を初期状態に戻す
     */
    fun resetState() {
        uiState = UploadUiState.Idle
    }

    // --- 共通の画像アップロード処理 ---
    @OptIn(ExperimentalTime::class)
    private suspend fun uploadImage(imageBytes: ByteArray): String? {
        return try {
            val fileName = "public/katana_${Clock.System.now().toEpochMilliseconds()}.jpg"
            val bucket = storage.from("katana")
            bucket.upload(path = fileName, data = imageBytes)
            bucket.publicUrl(fileName)
        } catch (e: Exception) {
            println("Image Upload Error: ${e.message}")
            null
        }
    }

    // --- 新規登録 ---
    fun registerKatana(
        shopName: String,
        name: String,
        katanaType: String,
        era: String,
        price: Int,
        dealerId: String,
        imageBytes: ByteArray?
    ) {
        viewModelScope.launch {
            uiState = UploadUiState.Loading
            try {
                val imageUrl = imageBytes?.let { uploadImage(it) }
                val result = apiClient.addKatana(
                    request = KatanaRequest(
                        shopName = shopName,
                        name = name,
                        katanaType = katanaType,
                        era = era,
                        price = price,
                        imageUrl = imageUrl,
                        dealerId = dealerId
                    )
                )
                uiState =
                    if (result) UploadUiState.Success else UploadUiState.Error("DB登録に失敗しました")
            } catch (e: Exception) {
                uiState = UploadUiState.Error("エラー: ${e.message}")
            }
        }
    }

    // --- 編集（更新） ---
    fun updateKatana(
        id: String,
        shopName: String,
        name: String,
        katanaType: String,
        era: String,
        price: Int,
        imageBytes: ByteArray?,
        currentImageUrl: String?
    ) {
        viewModelScope.launch {
            uiState = UploadUiState.Loading
            try {
                // 新しい画像が選択されていればアップロード、なければ既存のURLを維持
                val imageUrl = if (imageBytes != null) {
                    uploadImage(imageBytes) ?: currentImageUrl
                } else {
                    currentImageUrl
                }

                val result = apiClient.updateKatana(
                    id = id,
                    request = KatanaRequest(
                        shopName = shopName,
                        name = name,
                        katanaType = katanaType,
                        era = era,
                        price = price,
                        imageUrl = imageUrl,
                        dealerId = "" // 必要なければ空文字
                    )
                )
                uiState =
                    if (result) UploadUiState.Success else UploadUiState.Error("更新に失敗しました")
            } catch (e: Exception) {
                uiState = UploadUiState.Error("更新エラー: ${e.message}")
            }
        }
    }

    fun deleteKatana(id: String, dealerId: String, onComplete: (Boolean) -> Unit) {
        viewModelScope.launch {
            uiState = UploadUiState.Loading
            val success = apiClient.deleteKatana(id, dealerId)

            if (success) {
                uiState = UploadUiState.Idle // またはSuccess
                onComplete(true)
            } else {
                uiState = UploadUiState.Error("削除に失敗しました")
                onComplete(false)
            }
        }
    }
}

// 状態管理用の sealed class
sealed class UploadUiState {
    object Idle : UploadUiState()
    object Loading : UploadUiState()
    object Success : UploadUiState()
    data class Error(val message: String) : UploadUiState()
}