package sample.app.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.example.katana.models.KatanaResponse
import kotlinx.coroutines.launch
import sample.app.KatanaUploadViewModel
import sample.app.UploadUiState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun KatanaFormScreen(
    viewModel: KatanaUploadViewModel,
    onPickImage: (onImagePicked: (ByteArray) -> Unit) -> Unit,
    dealerId: String?,
    existingKatana: KatanaResponse? = null,
    onSaved: () -> Unit,
    onBack: () -> Unit
) {
    // 各項目の入力状態を管理
    var shopName by remember { mutableStateOf(existingKatana?.shopName ?: "") }
    var name by remember { mutableStateOf(existingKatana?.name ?: "") }
    var katanaType by remember { mutableStateOf(existingKatana?.katanaType ?: "") }
    var era by remember { mutableStateOf(existingKatana?.era ?: "") }
    var price by remember {
        mutableStateOf(
            if (existingKatana?.price != null) existingKatana.price.toString() else ""
        )
    }
    var selectedImageBytes by remember { mutableStateOf<ByteArray?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        viewModel.resetState()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (existingKatana == null) "刀剣登録" else "刀剣編集") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "戻る")
                    }
                }
            )
        },
        containerColor = MaterialTheme.colorScheme.background
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .padding(16.dp)
                .fillMaxSize()
                .verticalScroll(rememberScrollState()) // 画面からはみ出てもスクロール可能に
        ) {
            OutlinedTextField(
                value = shopName,
                onValueChange = { shopName = it },
                label = { Text("刀剣店名") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true
            )

            // 刀の名前
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text("刀の名前") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true
            )

            Spacer(modifier = Modifier.height(8.dp))

            // 種類
            OutlinedTextField(
                value = katanaType,
                onValueChange = { katanaType = it },
                label = { Text("種類 (例: 打刀, 脇差)") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true
            )

            Spacer(modifier = Modifier.height(8.dp))

            // 時代
            OutlinedTextField(
                value = era,
                onValueChange = { era = it },
                label = { Text("時代 (例: 江戸時代)") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true
            )

            Spacer(modifier = Modifier.height(8.dp))

            // 価格
            OutlinedTextField(
                value = price,
                onValueChange = { newValue ->
                    // 数字のみ（空文字含む）を許可するガード
                    if (newValue.all { it.isDigit() }) {
                        price = newValue
                    }
                },
                label = { Text("参考価格 (円)") },
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), // 数字キーボードを表示
                singleLine = true
            )

            Spacer(modifier = Modifier.height(10.dp))

            // --- 画像選択ボタンの追加 ---
            Button(
                onClick = {
                    onPickImage { bytes -> selectedImageBytes = bytes }
                },
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (selectedImageBytes != null) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.primary
                )
            ) {
                Text(if (selectedImageBytes == null) "刀の写真を選択" else "写真を選択済み ✅")
            }

            // UI状態の監視（ViewModelの状態を見る）
            val uiState = viewModel.uiState

            // 修正：ボタンの有効化条件（編集なら画像選択は任意にする）
            val isFormValid =
                name.isNotBlank() && (existingKatana != null || selectedImageBytes != null)
            // 申請ボタン
            Button(
                onClick = {
                    println("Debug: Save Button Clicked!")
                    scope.launch {
                        val priceInt = price.toIntOrNull() ?: 0
                        if (existingKatana == null) {
                            // 新規登録
                            viewModel.registerKatana(
                                shopName = shopName,
                                name = name,
                                katanaType = katanaType,
                                era = era,
                                price = priceInt,
                                dealerId = dealerId ?: "",
                                imageBytes = selectedImageBytes
                            )
                        } else {
                            println("Debug: Calling updateKatana...")
                            // 編集（更新）
                            viewModel.updateKatana(
                                id = existingKatana.id,
                                shopName = shopName,
                                name = name,
                                katanaType = katanaType,
                                era = era,
                                price = priceInt,
                                imageBytes = selectedImageBytes, // 新しく選んだ場合のみアップロード
                                currentImageUrl = existingKatana.imageUrl // 選ばなかったら今のURLを維持
                            )
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = uiState !is UploadUiState.Loading && isFormValid
            ) {
                if (uiState is UploadUiState.Loading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(24.dp),
                        color = MaterialTheme.colorScheme.onPrimary,
                        strokeWidth = 2.dp
                    )
                } else {
                    Text(if (existingKatana == null) "申請を送信する" else "変更を保存する")
                }
            }

            // 成功時の自動遷移
            LaunchedEffect(uiState) {
                println("Current UI State: $uiState")
                if (uiState is UploadUiState.Success) {
                    onSaved()
                }
            }
        }
    }
}