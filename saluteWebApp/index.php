<?php
session_start();

if (isset($_SESSION["user_id"])) {
    header("Location: dashboard.php");
    exit();
}
?>

<h1>Benvenuto 👋</h1>

<a href="login.php">Login</a><br>
<a href="registrazione.php">Registrati</a>