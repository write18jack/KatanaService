package sample.app

import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val context = LocalContext.current

            // 1. 画像選択後の処理を一時保存する変数
            var imagePickedCallback by remember { mutableStateOf<((ByteArray) -> Unit)?>(null) }

            // 2. Android固有のランチャー
            val launcher = rememberLauncherForActivityResult(
                contract = ActivityResultContracts.GetContent()
            ) { uri: Uri? ->
                uri?.let {
                    val bytes = context.contentResolver.openInputStream(it)?.readBytes()
                    if (bytes != null) {
                        imagePickedCallback?.invoke(bytes) // 共通コード側にデータを戻す
                    }
                }
            }

            App(
                onPickImage = { callback ->
                    imagePickedCallback = callback // コールバックを保持して
                    launcher.launch("image/*")     // ギャラリーを開く
                }
            )
        }
    }
}