package sample.app.ui

import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Image
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.SuggestionChipDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import com.example.katana.models.KatanaResponse
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun KatanaListScreen(
    katanas: List<KatanaResponse>,
    loggedInUserId: String, // 追加：誰がログインしているか判別用
    onItemClick: (KatanaResponse) -> Unit,
    onAddClick: () -> Unit,
    onLogout: () -> Unit
) {
    // 状態管理：タブの選択
    var selectedTabIndex by remember { mutableStateOf(0) }
    val tabs = listOf("すべて", "自店", "他店")

    // 1. Pagerの状態を管理 (初期ページは0)
    val pagerState = rememberPagerState(pageCount = { tabs.size })
    val scope = rememberCoroutineScope()

    var showLogoutDialog by remember { mutableStateOf(false) }

    // ログアウト確認ダイアログ
    if (showLogoutDialog) {
        AlertDialog(
            onDismissRequest = { showLogoutDialog = false }, // 枠外タップで閉じる
            title = { Text("ログアウト") },
            text = { Text("アカウントからログアウトして、ログイン画面に戻りますか？") },
            confirmButton = {
                TextButton(
                    onClick = {
                        showLogoutDialog = false
                        onLogout() // 実際のログアウト処理を実行
                    }
                ) {
                    Text("ログアウト", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { showLogoutDialog = false }) {
                    Text("キャンセル")
                }
            }
        )
    }

    Scaffold(
        topBar = {
            Column {
                TopAppBar(
                    title = {
                        Text(
                            "刀剣市場リサーチ",
                            style = MaterialTheme.typography.headlineMedium
                        )
                    },
                    actions = {
                        // --- ログアウトボタン ---
                        IconButton(onClick = { showLogoutDialog = true }) { // 3. ダイアログを表示させる
                            Icon(
                                imageVector = Icons.AutoMirrored.Filled.ExitToApp, // Icons.AutoMirrored.Filled.Logout,
                                contentDescription = "ログアウト",
                                tint = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                )
                // --- フィルタリングタブ ---
                TabRow(selectedTabIndex = pagerState.currentPage) {
                    tabs.forEachIndexed { index, title ->
                        Tab(
                            selected = selectedTabIndex == index,
                            onClick = {
                                // タップした時に該当ページへアニメーション移動
                                scope.launch {
                                    pagerState.animateScrollToPage(index)
                                }
                            },
                            text = { Text(title) }
                        )
                    }
                }
            }
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick = onAddClick,
                containerColor = MaterialTheme.colorScheme.primary
            ) {
                Icon(imageVector = Icons.Default.Add, contentDescription = "新規登録")
            }
        },
        containerColor = MaterialTheme.colorScheme.background
    ) { paddingValues ->
        // 3. HorizontalPager でコンテンツをスライド可能にする
        HorizontalPager(
            state = pagerState,
            modifier = Modifier.fillMaxSize().padding(paddingValues),
            verticalAlignment = Alignment.Top // 上揃えにする
        ) { pageIndex ->

            // ページ番号に応じたフィルタリング
            val displayKatanas = when (pageIndex) {
                1 -> katanas.filter { it.dealerId == loggedInUserId }
                2 -> katanas.filter { it.dealerId != loggedInUserId }
                else -> katanas
            }

            // 各ページの内容（中身は共通のリスト構造）
            KatanaListContent(
                filteredKatanas = displayKatanas,
                loggedInUserId = loggedInUserId,
                onItemClick = onItemClick
            )
        }
    }
}

@Composable
fun KatanaListContent(
    filteredKatanas: List<KatanaResponse>,
    loggedInUserId: String,
    onItemClick: (KatanaResponse) -> Unit
) {
    // 以前の相場パネルとLazyColumnをここにまとめる
    val avgPrice = if (filteredKatanas.isNotEmpty()) {
        // 合計を出してから個数で割る（計算前にDoubleにすることで精度を保つ）
        (filteredKatanas.sumOf { it.price.toDouble() } / filteredKatanas.size).toInt()
    } else {
        0
    }
    val maxPrice = filteredKatanas.maxOfOrNull { it.price } ?: 0

    Column {
        if (filteredKatanas.isNotEmpty()) {
            Card(
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)
            ) {
                Row(
                    modifier = Modifier.padding(16.dp),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Column {
                        Text("平均相場", style = MaterialTheme.typography.labelMedium)
                        Text(
                            "¥${formatPrice(avgPrice)}",
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold
                        )
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        Text("最高値", style = MaterialTheme.typography.labelMedium)
                        Text(
                            "¥${formatPrice(maxPrice)}",
                            style = MaterialTheme.typography.titleMedium
                        )
                    }
                }
            }
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            if (filteredKatanas.isEmpty()) {
                item {
                    Box(Modifier.fillParentMaxSize(), contentAlignment = Alignment.Center) {
                        Text("対象のデータがありません", color = MaterialTheme.colorScheme.outline)
                    }
                }
            } else {
                items(filteredKatanas) { katana ->
                    KatanaCard(
                        katana = katana,
                        isMine = katana.dealerId == loggedInUserId,

                        ) {
                        onItemClick(katana)
                    }
                }
            }
            item { Spacer(modifier = Modifier.height(80.dp)) }
        }
    }
}

@Composable
fun KatanaCard(katana: KatanaResponse, isMine: Boolean, onItemClick: () -> Unit) {
    Card(
        onClick = onItemClick,
        modifier = Modifier.fillMaxWidth(),
        elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
        colors = CardDefaults.cardColors(
            // 自分の持ち物なら少し色を変える（任意）
            containerColor = if (isMine) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.surface
        )
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {

                // --- 画像表示エリア ---
                Box(
                    modifier = Modifier
                        .size(80.dp) // 正方形の枠
                        .clip(RoundedCornerShape(8.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant),
                    contentAlignment = Alignment.Center
                ) {
                    if (!katana.imageUrl.isNullOrEmpty()) {
                        AsyncImage(
                            model = katana.imageUrl,
                            contentDescription = "刀剣画像",
                            modifier = Modifier.fillMaxSize(),
                            contentScale = ContentScale.Crop // 枠に合わせて切り抜き
                        )
                    } else {
                        // 画像がない場合のアイコン
                        Icon(
                            imageVector = Icons.Default.Image,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }

                Spacer(modifier = Modifier.width(16.dp))

                Text(
                    text = katana.name,
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold
                )

                // 自店ラベル または ステータス
                if (isMine) {
                    SuggestionChip(
                        onClick = { onItemClick() },
                        label = { Text("自店在庫") },
                        colors = SuggestionChipDefaults.suggestionChipColors(
                            containerColor = MaterialTheme.colorScheme.primaryContainer,
                            labelColor = MaterialTheme.colorScheme.onPrimaryContainer
                        )
                    )
                } else {
                    Surface(
                        shape = RoundedCornerShape(16.dp),
                        color = MaterialTheme.colorScheme.secondaryContainer
                    ) {
                        Text(
                            text = katana.status,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                            style = MaterialTheme.typography.labelSmall
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.height(8.dp))
            Text(text = "種別: ${katana.katanaType}", style = MaterialTheme.typography.bodyMedium)
            Text(text = "時代: ${katana.era}", style = MaterialTheme.typography.bodyMedium)

            HorizontalDivider(Modifier.padding(vertical = 8.dp))

            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "¥${formatPrice(katana.price)}",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.primary,
                    fontWeight = FontWeight.Bold
                )
                Spacer(modifier = Modifier.weight(1f))
                Text(
                    text = katana.shopName,
                    style = MaterialTheme.typography.bodySmall,
                    fontStyle = FontStyle.Italic
                )
            }
        }
    }
}

fun formatPrice(price: Int): String =
    price.toString().reversed().chunked(3).joinToString(",").reversed()
