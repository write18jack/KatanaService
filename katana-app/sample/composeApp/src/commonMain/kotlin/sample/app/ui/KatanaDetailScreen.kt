package sample.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Image
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.painter.ColorPainter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import com.example.katana.models.KatanaResponse
import sample.app.KatanaUploadViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun KatanaDetailScreen(
    katana: KatanaResponse,
    loggedInUserId: String,
    viewModel: KatanaUploadViewModel,
    onEditClick: (KatanaResponse) -> Unit,
    onDeleted: () -> Unit,
    onBack: () -> Unit
) {

    var showDeleteDialog by remember { mutableStateOf(false) }
    // 拡大表示中かどうかのフラグ
    var isImageExpanded by remember { mutableStateOf(false) }

    // --- 確認ダイアログ ---
    if (showDeleteDialog) {
        AlertDialog(
            onDismissRequest = { showDeleteDialog = false },
            title = { Text("削除の確認") },
            text = { Text("この刀剣データを削除してもよろしいですか？この操作は取り消せません。") },
            confirmButton = {
                TextButton(onClick = {
                    showDeleteDialog = false
                    viewModel.deleteKatana(katana.id, katana.dealerId) { success ->
                        if (success) onDeleted() // 成功したら一覧に戻る
                    }
                }) {
                    Text("削除", color = Color.Red)
                }
            },
            dismissButton = {
                TextButton(onClick = { showDeleteDialog = false }) {
                    Text("キャンセル")
                }
            }
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("刀剣詳細") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "戻る")
                    }
                },
                actions = {
                    // 自分の刀（dealerIdが一致する）場合のみ削除ボタンを表示
                    if (katana.dealerId == loggedInUserId) {
                        IconButton(onClick = { onEditClick(katana) }) {
                            Icon(Icons.Default.Image, contentDescription = "編集")
                        }
                        IconButton(onClick = { showDeleteDialog = true }) {
                            Icon(
                                Icons.Default.Delete,
                                contentDescription = "削除",
                                tint = Color.Red
                            )
                        }
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .padding(16.dp)
                .verticalScroll(rememberScrollState())
        ) {
            // 画像
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(300.dp) // 詳細なので大きく表示
                    .background(MaterialTheme.colorScheme.surfaceVariant)
                    .clickable { isImageExpanded = true }, // タップで拡大
                contentAlignment = Alignment.Center
            ) {
                if (!katana.imageUrl.isNullOrEmpty()) {
                    AsyncImage(
                        model = katana.imageUrl,
                        contentDescription = "${katana.name}の画像",
                        modifier = Modifier.fillMaxSize(),
                        contentScale = ContentScale.Fit,
                        placeholder = ColorPainter(Color.LightGray),
                        error = ColorPainter(Color.Gray),
                    )
                } else {
                    // 画像がない場合の代替表示
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(
                            imageVector = Icons.Default.Image,
                            contentDescription = null,
                            modifier = Modifier.size(64.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Text("画像がありません", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }

            // 大きな名前表示
            Text(text = katana.name, style = MaterialTheme.typography.headlineLarge)
            Text(text = "店舗: ${katana.shopName}", color = MaterialTheme.colorScheme.secondary)

            Spacer(modifier = Modifier.height(24.dp))

            // 詳細情報テーブル風
            DetailRow("価格", "¥${formatPrice(katana.price)}")
            DetailRow("種別", katana.katanaType)
            DetailRow("時代", katana.era)
            DetailRow("状態", katana.status)
            DetailRow("ID", katana.id)

            Spacer(modifier = Modifier.height(32.dp))

            Button(
                onClick = { /* 購入/予約ロジック等 */ },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("この刀剣について問い合わせる")
            }
        }

        // --- 拡大表示オーバーレイ ---
        if (isImageExpanded) {
            Surface(
                modifier = Modifier
                    .fillMaxSize()
                    .clickable { isImageExpanded = false }, // 背景タップで閉じる
                color = Color.Black.copy(alpha = 0.9f) // 背景を暗くする
            ) {
                Box(contentAlignment = Alignment.Center) {
                    AsyncImage(
                        model = katana.imageUrl,
                        contentDescription = "拡大画像",
                        modifier = Modifier.fillMaxSize(),
                        contentScale = ContentScale.Fit
                    )
                }
            }
        }
    }
}

@Composable
fun DetailRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(text = label, fontWeight = FontWeight.Bold)
        Text(text = value)
    }
}